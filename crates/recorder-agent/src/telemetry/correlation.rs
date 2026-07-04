use super::{ChannelCorrelation, round_2};

#[derive(Default)]
pub(super) struct ChannelPairStats {
    pub(super) left: usize,
    pub(super) right: usize,
    sample_count: u64,
    sum_left: f64,
    sum_right: f64,
    sum_left_squares: f64,
    sum_right_squares: f64,
    sum_products: f64,
}

impl ChannelPairStats {
    pub(super) fn observe(&mut self, left: f64, right: f64) {
        self.sample_count += 1;
        self.sum_left += left;
        self.sum_right += right;
        self.sum_left_squares += left * left;
        self.sum_right_squares += right * right;
        self.sum_products += left * right;
    }

    fn correlation(&self) -> Option<f32> {
        if self.sample_count < 8 {
            return None;
        }

        let sample_count = self.sample_count as f64;
        let covariance = sample_count * self.sum_products - self.sum_left * self.sum_right;
        let left_variance = sample_count * self.sum_left_squares - self.sum_left * self.sum_left;
        let right_variance =
            sample_count * self.sum_right_squares - self.sum_right * self.sum_right;

        if left_variance <= f64::EPSILON || right_variance <= f64::EPSILON {
            return None;
        }

        Some((covariance / (left_variance.sqrt() * right_variance.sqrt())).clamp(-1.0, 1.0) as f32)
    }
}

pub(super) fn channel_pairs(channel_count: usize) -> Vec<ChannelPairStats> {
    let mut pairs = Vec::new();

    for left in 0..channel_count {
        for right in (left + 1)..channel_count {
            pairs.push(ChannelPairStats {
                left,
                right,
                ..ChannelPairStats::default()
            });
        }
    }

    pairs
}

pub(super) fn strongest_channel_correlations(
    pairs: &[ChannelPairStats],
    rms_dbfs: &[f32],
) -> Vec<Option<ChannelCorrelation>> {
    const AUDIBLE_DBFS: f32 = -65.0;
    const DISPLAY_MIN_ABS_SCORE: f32 = 0.80;

    let mut strongest = vec![None; rms_dbfs.len()];

    for pair in pairs {
        if rms_dbfs[pair.left] <= AUDIBLE_DBFS || rms_dbfs[pair.right] <= AUDIBLE_DBFS {
            continue;
        }

        let Some(score) = pair.correlation() else {
            continue;
        };

        if score.abs() < DISPLAY_MIN_ABS_SCORE {
            continue;
        }

        remember_correlation(&mut strongest, pair.left, pair.right, score);
        remember_correlation(&mut strongest, pair.right, pair.left, score);
    }

    strongest
}

fn remember_correlation(
    strongest: &mut [Option<ChannelCorrelation>],
    channel_index: usize,
    peer_index: usize,
    score: f32,
) {
    let should_replace = strongest[channel_index]
        .as_ref()
        .is_none_or(|current| score.abs() > current.score.abs());

    if should_replace {
        strongest[channel_index] = Some(ChannelCorrelation {
            peer_channel_index: u16::try_from(peer_index + 1).unwrap_or(u16::MAX),
            phase: if score < 0.0 { "inverted" } else { "same" },
            score: round_2(score),
        });
    }
}

pub(super) fn amplitude_to_dbfs(value: f64) -> f32 {
    if value <= 0.0 {
        return -160.0;
    }

    (20.0 * value.log10()).max(-160.0) as f32
}
