# Model logos

Source: https://github.com/lobehub/lobe-icons (MIT), static SVG package version 1.94.0.

Original assets: https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.94.0/icons/

The standard SVGs resolve monochrome `currentColor` to #252a42 for light surfaces.
The `-dark.svg` variants use #eceef6 for monochrome marks and lighter stops in
colored gradients, preserving the original geometry and brand hues. They are
selected by the application theme in `styles/theme.css`.

Wan uses the Qwen color mark from Lobe Icons, matching `Qwen.Color` in
`@lobehub/icons`. Source:
https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/qwen-color.svg
The light variant preserves the original asset; the dark variant lightens the
purple gradient for contrast while preserving its geometry.

Kling uses the Kling color mark from Lobe Icons static SVG package version 1.98.0.
Source:
https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/kling-color.svg
The light variant preserves the original asset; the dark variant lightens the
deep blue gradient stop for contrast while preserving its geometry.

Text model marks (DeepSeek, Claude, Kimi, Zhipu) use the Lobe Icons MIT
`*-color.svg` assets, preserving their original brand colors in both themes.
The earlier monochrome files remain available for cached clients.
