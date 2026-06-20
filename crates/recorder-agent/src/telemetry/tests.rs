use super::*;

#[test]
fn computes_s16le_meter_levels_per_channel() {
    let pcm = [0_i16, i16::MAX, 16384_i16, -16384_i16, -32768_i16, 0_i16]
        .into_iter()
        .flat_map(i16::to_le_bytes)
        .collect::<Vec<_>>();

    let frame =
        pcm_s16le_meter_frame_at("node_1", "iface_1", &pcm, 2, -1.0, "2026-06-18T00:00:00Z")
            .expect("meter frame");

    assert_eq!(frame.levels.len(), 2);
    assert_eq!(frame.levels[0].channel_index, 1);
    assert!(frame.levels[0].clipping);
    assert!(frame.levels[0].peak_dbfs >= -0.1);
    assert!(frame.levels[1].rms_dbfs < frame.levels[1].peak_dbfs);
}

#[test]
fn builds_mono_monitor_wav_from_interleaved_pcm() {
    let pcm = [1000_i16, -1000_i16, 3000_i16, -3000_i16]
        .into_iter()
        .flat_map(i16::to_le_bytes)
        .collect::<Vec<_>>();
    let wav = pcm_s16le_monitor_wav(&pcm, 2, 2, 2).expect("monitor wav");

    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
    assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 2);
    assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 4);
}

#[test]
fn rejects_empty_channel_count() {
    let error = pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        &[0, 0],
        0,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect_err("channel count should fail");

    assert!(error.to_string().contains("at least one channel"));
}

#[test]
fn computes_silence_as_floor_dbfs() {
    let frame = pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        &[0, 0, 0, 0],
        2,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect("silence");

    assert_eq!(frame.levels[0].rms_dbfs, -160.0);
    assert_eq!(frame.levels[1].peak_dbfs, -160.0);
    assert_eq!(frame.levels[0].quality.speech_score, 0.0);
    assert_eq!(frame.levels[0].quality.noise_score, 0.0);
    assert_eq!(frame.levels[0].quality.broadband_noise_score, 0.0);
    assert_eq!(frame.levels[0].quality.hum_score, 0.0);
    assert_eq!(frame.levels[0].quality.static_score, 0.0);
    assert_eq!(frame.levels[0].quality.estimated_snr_db, 0.0);
    assert_eq!(frame.levels[0].quality.intelligibility_score, 0.0);
    assert!(!frame.levels[0].clipping);
}

#[test]
fn estimates_speech_like_quality_from_pcm_shape() {
    let pcm = (0..480)
        .map(|index| {
            let envelope = if index % 29 < 14 { 0.9 } else { 0.35 };
            let sign = if index % 17 < 8 { 1.0 } else { -1.0 };
            (sign * envelope * 10_000.0) as i16
        })
        .flat_map(i16::to_le_bytes)
        .collect::<Vec<_>>();

    let frame =
        pcm_s16le_meter_frame_at("node_1", "iface_1", &pcm, 1, -1.0, "2026-06-18T00:00:00Z")
            .expect("speech-like frame");

    assert!(frame.levels[0].quality.speech_score > frame.levels[0].quality.noise_score);
    assert!(frame.levels[0].quality.speech_like);
}

#[test]
fn estimates_hum_and_static_likelihood_from_pcm_shape() {
    let hum_pcm = (0..960)
        .map(|index| {
            let phase = index as f32 / 80.0 * std::f32::consts::TAU;

            (phase.sin() * 12_000.0) as i16
        })
        .flat_map(i16::to_le_bytes)
        .collect::<Vec<_>>();
    let static_pcm = (0..960)
        .map(|index| {
            if index % 2 == 0 {
                10_000_i16
            } else {
                -10_000_i16
            }
        })
        .flat_map(i16::to_le_bytes)
        .collect::<Vec<_>>();
    let hum_frame = pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        &hum_pcm,
        1,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect("hum-like frame");
    let static_frame = pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        &static_pcm,
        1,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect("static-like frame");

    assert!(hum_frame.levels[0].quality.hum_score > 0.4);
    assert!(hum_frame.levels[0].quality.hum_score > hum_frame.levels[0].quality.static_score);
    assert!(static_frame.levels[0].quality.static_score > 0.8);
    assert!(static_frame.levels[0].quality.static_score > static_frame.levels[0].quality.hum_score);
}

#[test]
fn calibrates_voice_hum_static_and_silence_fixtures() {
    let voice_frame = fixture_frame(&voice_like_pcm(4_800), 1);
    let hum_frame = fixture_frame(&hum_pcm(4_800), 1);
    let broadband_frame = fixture_frame(&broadband_noise_pcm(4_800), 1);
    let static_frame = fixture_frame(&static_pcm(4_800), 1);
    let silence_frame = fixture_frame(&silence_pcm(4_800), 1);
    let voice = &voice_frame.levels[0].quality;
    let hum = &hum_frame.levels[0].quality;
    let broadband_noise = &broadband_frame.levels[0].quality;
    let static_noise = &static_frame.levels[0].quality;
    let silence = &silence_frame.levels[0].quality;

    assert!(voice.speech_like);
    assert!(voice.speech_score >= 0.65);
    assert!(voice.speech_score > voice.noise_score);
    assert!(voice.hum_score < 0.35);
    assert!(voice.static_score < 0.35);
    assert!(voice.estimated_snr_db >= 12.0);
    assert!(voice.intelligibility_score >= 0.45);
    assert!(!hum.speech_like);
    assert!(hum.hum_score >= 0.65);
    assert!(hum.hum_score > hum.speech_score);
    assert!(hum.hum_score > hum.static_score);
    assert!(voice.estimated_snr_db > hum.estimated_snr_db);
    assert!(voice.intelligibility_score > hum.intelligibility_score);
    assert!(broadband_noise.broadband_noise_score >= 0.65);
    assert!(broadband_noise.broadband_noise_score > voice.broadband_noise_score);
    assert!(broadband_noise.broadband_noise_score > hum.broadband_noise_score);
    assert!(!static_noise.speech_like);
    assert!(static_noise.static_score >= 0.85);
    assert!(static_noise.static_score > static_noise.speech_score);
    assert_eq!(silence.speech_score, 0.0);
}

#[test]
fn calibration_fixtures_keep_independent_channels_uncorrelated() {
    let frame = fixture_frame(&independent_stereo_pcm(4_800), 2);

    assert!(frame.levels[0].quality.channel_correlation.is_none());
    assert!(frame.levels[1].quality.channel_correlation.is_none());
}

#[test]
fn estimates_same_phase_and_inverted_channel_correlation() {
    let same_phase_pcm = correlated_pcm(false);
    let inverted_phase_pcm = correlated_pcm(true);
    let same_phase_frame = pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        &same_phase_pcm,
        2,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect("same-phase frame");
    let inverted_phase_frame = pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        &inverted_phase_pcm,
        2,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect("inverted-phase frame");
    let same_phase = same_phase_frame.levels[0]
        .quality
        .channel_correlation
        .as_ref()
        .expect("same phase correlation");
    let inverted_phase = inverted_phase_frame.levels[0]
        .quality
        .channel_correlation
        .as_ref()
        .expect("inverted phase correlation");

    assert_eq!(same_phase.peer_channel_index, 2);
    assert_eq!(same_phase.phase, "same");
    assert!(same_phase.score > 0.98);
    assert_eq!(inverted_phase.peer_channel_index, 2);
    assert_eq!(inverted_phase.phase, "inverted");
    assert!(inverted_phase.score < -0.98);
}

#[test]
fn ignores_silent_channel_correlation() {
    let frame = pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        2,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect("silent frame");

    assert!(frame.levels[0].quality.channel_correlation.is_none());
    assert!(frame.levels[1].quality.channel_correlation.is_none());
}

fn correlated_pcm(inverted: bool) -> Vec<u8> {
    (0..128)
        .flat_map(|index| {
            let sample = (((index as f32 / 11.0).sin() * 16_000.0) as i16).clamp(-16_000, 16_000);
            let peer = if inverted { -sample } else { sample };

            [sample, peer].into_iter().flat_map(i16::to_le_bytes)
        })
        .collect()
}

fn fixture_frame(pcm: &[u8], channel_count: u16) -> MeterFrame {
    pcm_s16le_meter_frame_at(
        "node_1",
        "iface_1",
        pcm,
        channel_count,
        -1.0,
        "2026-06-18T00:00:00Z",
    )
    .expect("fixture frame")
}

fn voice_like_pcm(samples: usize) -> Vec<u8> {
    mono_pcm(samples, |index| {
        let time = index as f32 / 48_000.0;
        let phrase_envelope = if index % 43 < 25 { 0.95 } else { 0.28 };
        let syllable_envelope = 0.55 + 0.45 * (time * 5.0 * std::f32::consts::TAU).sin().abs();
        let voiced_sign = if index % 10 < 5 { 1.0 } else { -1.0 };
        let formant_motion = 0.72
            + (time * 730.0 * std::f32::consts::TAU).sin() * 0.18
            + (time * 1_800.0 * std::f32::consts::TAU).sin() * 0.1;

        voiced_sign * formant_motion * phrase_envelope * syllable_envelope * 11_000.0
    })
}

fn hum_pcm(samples: usize) -> Vec<u8> {
    mono_pcm(samples, |index| {
        let time = index as f32 / 48_000.0;

        (time * 60.0 * std::f32::consts::TAU).sin() * 12_000.0
    })
}

fn static_pcm(samples: usize) -> Vec<u8> {
    mono_pcm(
        samples,
        |index| {
            if index % 2 == 0 { 10_000.0 } else { -10_000.0 }
        },
    )
}

fn broadband_noise_pcm(samples: usize) -> Vec<u8> {
    mono_pcm(samples, |index| {
        let mut state = (index as u32).wrapping_mul(0x9E37_79B9);

        state ^= state >> 16;
        state = state.wrapping_mul(0x85EB_CA6B);
        state ^= state >> 13;
        state = state.wrapping_mul(0xC2B2_AE35);
        state ^= state >> 16;

        let centered = ((state >> 16) as f32 / 65_535.0) * 2.0 - 1.0;

        centered * 9_000.0
    })
}

fn silence_pcm(samples: usize) -> Vec<u8> {
    mono_pcm(samples, |_| 0.0)
}

fn independent_stereo_pcm(samples: usize) -> Vec<u8> {
    (0..samples)
        .flat_map(|index| {
            let time = index as f32 / 48_000.0;
            let left = (time * 230.0 * std::f32::consts::TAU).sin() * 11_000.0;
            let right = (time * 1_370.0 * std::f32::consts::TAU + 0.7).sin() * 9_000.0;

            [to_i16(left), to_i16(right)]
                .into_iter()
                .flat_map(i16::to_le_bytes)
        })
        .collect()
}

fn mono_pcm(samples: usize, sample: impl Fn(usize) -> f32) -> Vec<u8> {
    (0..samples)
        .map(|index| to_i16(sample(index)))
        .flat_map(i16::to_le_bytes)
        .collect()
}

fn to_i16(sample: f32) -> i16 {
    sample.clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16
}
