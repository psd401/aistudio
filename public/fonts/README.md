# Local web fonts

These Latin variable-font assets are checked in deliberately. `next/font/google`
downloads font CSS and binaries during every production build, which makes an
otherwise valid build fail when Google Fonts or DNS is unavailable.

- `Inter-Variable.woff2`: Google Fonts Inter v20, weights 100–900, Latin subset
- `SchibstedGrotesk-Variable.woff2`: Google Fonts Schibsted Grotesk v7,
  weights 400–700, Latin subset
- `OFL.txt`: SIL Open Font License 1.1

When updating either font, obtain the current Latin WOFF2 URL from the official
Google Fonts CSS API, replace the asset, and keep the application on
`next/font/local`. Do not reintroduce `next/font/google`; production builds must
remain network-independent.
