const MAX_COUNT: u32 = 999;
const SIZE: u32 = 32;

pub fn clamp(count: u32) -> u32 {
    count.min(MAX_COUNT)
}

pub fn tooltip(count: u32) -> String {
    match count {
        0 => "Harmony".into(),
        1 => "Harmony: 1 unread".into(),
        n => format!("Harmony: {n} unread"),
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
/// A red dot for the Windows taskbar overlay, as RGBA pixels.
pub fn overlay_rgba() -> Vec<u8> {
    let radius = f64::from(SIZE) / 2.0;
    let mut pixels = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = f64::from(x) + 0.5 - radius;
            let dy = f64::from(y) + 0.5 - radius;
            let inside = dx.hypot(dy) <= radius - 1.0;
            pixels.extend_from_slice(if inside {
                &[0xe5, 0x39, 0x35, 0xff]
            } else {
                &[0, 0, 0, 0]
            });
        }
    }
    pixels
}

#[cfg_attr(not(windows), allow(dead_code))]
pub const OVERLAY_SIZE: u32 = SIZE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_large_counts() {
        assert_eq!(clamp(0), 0);
        assert_eq!(clamp(42), 42);
        assert_eq!(clamp(u32::MAX), 999);
    }

    #[test]
    fn tooltip_reads_naturally() {
        assert_eq!(tooltip(0), "Harmony");
        assert_eq!(tooltip(1), "Harmony: 1 unread");
        assert_eq!(tooltip(7), "Harmony: 7 unread");
    }

    #[test]
    fn overlay_is_an_opaque_dot_on_a_transparent_square() {
        let pixels = overlay_rgba();
        assert_eq!(pixels.len(), (OVERLAY_SIZE * OVERLAY_SIZE * 4) as usize);
        assert_eq!(pixels[3], 0, "corner is transparent");
        let center = ((OVERLAY_SIZE / 2 * OVERLAY_SIZE + OVERLAY_SIZE / 2) * 4) as usize;
        assert_eq!(pixels[center + 3], 0xff, "center is opaque");
    }
}
