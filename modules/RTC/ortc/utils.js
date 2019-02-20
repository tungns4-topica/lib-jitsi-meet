/* global RTCRtpReceiver */

import sdpTransform from 'sdp-transform';

/**
 * Extract RTP capabilities from remote description.
 * @param {Object} sdpObject - Remote SDP object generated by sdp-transform.
 * @return {RTCRtpCapabilities}
 */
export function extractCapabilities(sdpObject) {
    // Map of RtpCodecParameters indexed by payload type.
    const codecsMap = new Map();

    // Array of RtpHeaderExtensions.
    const headerExtensions = [];

    for (const m of sdpObject.media) {
        // Media kind.
        const kind = m.type;

        if (kind !== 'audio' && kind !== 'video') {
            continue; // eslint-disable-line no-continue
        }

        // Get codecs.
        for (const rtp of m.rtp) {
            const codec = {
                clockRate: rtp.rate,
                kind,
                mimeType: `${kind}/${rtp.codec}`,
                name: rtp.codec,
                numChannels: rtp.encoding || 1,
                parameters: {},
                preferredPayloadType: rtp.payload,
                rtcpFeedback: []
            };

            codecsMap.set(codec.preferredPayloadType, codec);
        }

        // Get codec parameters.
        for (const fmtp of m.fmtp || []) {
            const parameters = sdpTransform.parseFmtpConfig(fmtp.config);
            const codec = codecsMap.get(fmtp.payload);

            if (!codec) {
                continue; // eslint-disable-line no-continue
            }

            codec.parameters = parameters;
        }

        // Get RTCP feedback for each codec.
        for (const fb of m.rtcpFb || []) {
            const codec = codecsMap.get(fb.payload);

            if (!codec) {
                continue; // eslint-disable-line no-continue
            }

            codec.rtcpFeedback.push({
                parameter: fb.subtype || '',
                type: fb.type
            });
        }

        // Get RTP header extensions.
        for (const ext of m.ext || []) {
            const preferredId = ext.value;
            const uri = ext.uri;
            const headerExtension = {
                kind,
                uri,
                preferredId
            };

            // Check if already present.
            const duplicated = headerExtensions.find(savedHeaderExtension =>
                headerExtension.kind === savedHeaderExtension.kind
                    && headerExtension.uri === savedHeaderExtension.uri
            );

            if (!duplicated) {
                headerExtensions.push(headerExtension);
            }
        }
    }

    return {
        codecs: Array.from(codecsMap.values()),
        fecMechanisms: [], // TODO
        headerExtensions
    };
}

/**
 * Extract DTLS parameters from remote description.
 * @param {Object} sdpObject - Remote SDP object generated by sdp-transform.
 * @return {RTCDtlsParameters}
 */
export function extractDtlsParameters(sdpObject) {
    const media = getFirstActiveMediaSection(sdpObject);
    const fingerprint = media.fingerprint || sdpObject.fingerprint;
    let role;

    switch (media.setup) {
    case 'active':
        role = 'client';
        break;
    case 'passive':
        role = 'server';
        break;
    case 'actpass':
        role = 'auto';
        break;
    }

    return {
        role,
        fingerprints: [
            {
                algorithm: fingerprint.type,
                value: fingerprint.hash
            }
        ]
    };
}

/**
 * Extract ICE candidates from remote description.
 * NOTE: This implementation assumes a single BUNDLEd transport and rtcp-mux.
 * @param {Object} sdpObject - Remote SDP object generated by sdp-transform.
 * @return {sequence<RTCIceCandidate>}
 */
export function extractIceCandidates(sdpObject) {
    const media = getFirstActiveMediaSection(sdpObject);
    const candidates = [];

    for (const c of media.candidates) {
        // Ignore RTCP candidates (we assume rtcp-mux).
        if (c.component !== 1) {
            continue; // eslint-disable-line no-continue
        }

        const candidate = {
            foundation: c.foundation,
            ip: c.ip,
            port: c.port,
            priority: c.priority,
            protocol: c.transport.toLowerCase(),
            type: c.type
        };

        candidates.push(candidate);
    }

    return candidates;
}

/**
 * Extract ICE parameters from remote description.
 * NOTE: This implementation assumes a single BUNDLEd transport.
 * @param {Object} sdpObject - Remote SDP object generated by sdp-transform.
 * @return {RTCIceParameters}
 */
export function extractIceParameters(sdpObject) {
    const media = getFirstActiveMediaSection(sdpObject);
    const usernameFragment = media.iceUfrag;
    const password = media.icePwd;
    const icelite = sdpObject.icelite === 'ice-lite';

    return {
        icelite,
        password,
        usernameFragment
    };
}

/**
 * Extract MID values from remote description.
 * @param {Object} sdpObject - Remote SDP object generated by sdp-transform.
 * @return {map<String, String>} Ordered Map with MID as key and kind as value.
 */
export function extractMids(sdpObject) {
    const midToKind = new Map();

    // Ignore disabled media sections.
    for (const m of sdpObject.media) {
        midToKind.set(m.mid, m.type);
    }

    return midToKind;
}

/**
 * Extract tracks information.
 * @param {Object} sdpObject - Remote SDP object generated by sdp-transform.
 * @return {Map}
 */
export function extractTrackInfos(sdpObject) {
    // Map with info about receiving media.
    // - index: Media SSRC
    // - value: Object
    //   - kind: 'audio' / 'video'
    //   - ssrc: Media SSRC
    //   - rtxSsrc: RTX SSRC (may be unset)
    //   - streamId: MediaStream.jitsiRemoteId
    //   - trackId: MediaStreamTrack.jitsiRemoteId
    //   - cname: CNAME
    // @type {map<Number, Object>}
    const infos = new Map();

    // Map with stream SSRC as index and associated RTX SSRC as value.
    // @type {map<Number, Number>}
    const rtxMap = new Map();

    // Set of RTX SSRC values.
    const rtxSet = new Set();

    for (const m of sdpObject.media) {
        const kind = m.type;

        if (kind !== 'audio' && kind !== 'video') {
            continue; // eslint-disable-line no-continue
        }

        // Get RTX information.
        for (const ssrcGroup of m.ssrcGroups || []) {
            // Just consider FID.
            if (ssrcGroup.semantics !== 'FID') {
                continue; // eslint-disable-line no-continue
            }

            const ssrcs
                = ssrcGroup.ssrcs.split(' ').map(ssrc => Number(ssrc));
            const ssrc = ssrcs[0];
            const rtxSsrc = ssrcs[1];

            rtxMap.set(ssrc, rtxSsrc);
            rtxSet.add(rtxSsrc);
        }

        for (const ssrcObject of m.ssrcs || []) {
            const ssrc = ssrcObject.id;

            // Ignore RTX.
            if (rtxSet.has(ssrc)) {
                continue; // eslint-disable-line no-continue
            }

            let info = infos.get(ssrc);

            if (!info) {
                info = {
                    kind,
                    rtxSsrc: rtxMap.get(ssrc),
                    ssrc
                };

                infos.set(ssrc, info);
            }

            switch (ssrcObject.attribute) {
            case 'cname': {
                info.cname = ssrcObject.value;
                break;
            }
            case 'msid': {
                const values = ssrcObject.value.split(' ');
                const streamId = values[0];
                const trackId = values[1];

                info.streamId = streamId;
                info.trackId = trackId;
                break;
            }
            case 'mslabel': {
                const streamId = ssrcObject.value;

                info.streamId = streamId;
                break;
            }
            case 'label': {
                const trackId = ssrcObject.value;

                info.trackId = trackId;
                break;
            }
            }
        }
    }

    return infos;
}

/**
 * Get local ORTC RTP capabilities filtered and adapted to the given remote RTP
 * capabilities.
 * @param {RTCRtpCapabilities} filterWithCapabilities - RTP capabilities to
 * filter with.
 * @return {RTCRtpCapabilities}
 */
export function getLocalCapabilities(filterWithCapabilities) {
    const localFullCapabilities = RTCRtpReceiver.getCapabilities();
    const localCapabilities = {
        codecs: [],
        fecMechanisms: [],
        headerExtensions: []
    };

    // Map of RTX and codec payloads.
    // - index: Codec payloadType
    // - value: Associated RTX payloadType
    // @type {map<Number, Number>}
    const remoteRtxMap = new Map();

    // Set codecs.
    for (const remoteCodec of filterWithCapabilities.codecs) {
        const remoteCodecName = remoteCodec.name.toLowerCase();

        if (remoteCodecName === 'rtx') {
            remoteRtxMap.set(
                remoteCodec.parameters.apt, remoteCodec.preferredPayloadType);

            continue; // eslint-disable-line no-continue
        }

        const localCodec = localFullCapabilities.codecs.find(codec =>
            codec.name.toLowerCase() === remoteCodecName
                && codec.kind === remoteCodec.kind
                && codec.clockRate === remoteCodec.clockRate
        );

        if (!localCodec) {
            continue; // eslint-disable-line no-continue
        }

        const codec = {
            clockRate: localCodec.clockRate,
            kind: localCodec.kind,
            mimeType: `${localCodec.kind}/${localCodec.name}`,
            name: localCodec.name,
            numChannels: localCodec.numChannels || 1,
            parameters: {},
            preferredPayloadType: remoteCodec.preferredPayloadType,
            rtcpFeedback: []
        };

        for (const remoteParamName of Object.keys(remoteCodec.parameters)) {
            const remoteParamValue
                = remoteCodec.parameters[remoteParamName];

            for (const localParamName of Object.keys(localCodec.parameters)) {
                const localParamValue
                    = localCodec.parameters[localParamName];

                if (localParamName !== remoteParamName) {
                    continue; // eslint-disable-line no-continue
                }

                // TODO: We should consider much more cases here, but Edge
                // does not support many codec parameters.
                if (localParamValue === remoteParamValue) {
                    // Use this RTP parameter.
                    codec.parameters[localParamName] = localParamValue;
                    break;
                }
            }
        }

        for (const remoteFb of remoteCodec.rtcpFeedback) {
            const localFb = localCodec.rtcpFeedback.find(fb =>
                fb.type === remoteFb.type
                    && fb.parameter === remoteFb.parameter
            );

            if (localFb) {
                // Use this RTCP feedback.
                codec.rtcpFeedback.push(localFb);
            }
        }

        // Use this codec.
        localCapabilities.codecs.push(codec);
    }

    // Add RTX for video codecs.
    for (const codec of localCapabilities.codecs) {
        const payloadType = codec.preferredPayloadType;

        if (!remoteRtxMap.has(payloadType)) {
            continue; // eslint-disable-line no-continue
        }

        const rtxCodec = {
            clockRate: codec.clockRate,
            kind: codec.kind,
            mimeType: `${codec.kind}/rtx`,
            name: 'rtx',
            parameters: {
                apt: payloadType
            },
            preferredPayloadType: remoteRtxMap.get(payloadType),
            rtcpFeedback: []
        };

        // Add RTX codec.
        localCapabilities.codecs.push(rtxCodec);
    }

    // Add RTP header extensions.
    for (const remoteExtension of filterWithCapabilities.headerExtensions) {
        const localExtension
            = localFullCapabilities.headerExtensions.find(extension =>
                extension.kind === remoteExtension.kind
                    && extension.uri === remoteExtension.uri
            );

        if (localExtension) {
            const extension = {
                kind: localExtension.kind,
                preferredEncrypt: Boolean(remoteExtension.preferredEncrypt),
                preferredId: remoteExtension.preferredId,
                uri: localExtension.uri
            };

            // Use this RTP header extension.
            localCapabilities.headerExtensions.push(extension);
        }
    }

    // Add FEC mechanisms.
    // NOTE: We don't support FEC yet and, in fact, neither does Edge.
    for (const remoteFecMechanism of filterWithCapabilities.fecMechanisms) {
        const localFecMechanism
            = localFullCapabilities.fecMechanisms.find(fec =>
                fec === remoteFecMechanism
            );

        if (localFecMechanism) {
            // Use this FEC mechanism.
            localCapabilities.fecMechanisms.push(localFecMechanism);
        }
    }

    return localCapabilities;
}

/**
 * Get the first acive media section.
 * @param {Object} sdpObject - SDP object generated by sdp-transform.
 * @return {Object} SDP media section as parsed by sdp-transform.
 */
function getFirstActiveMediaSection(sdpObject) {
    return sdpObject.media.find(m =>
        m.iceUfrag && m.port !== 0
    );
}
