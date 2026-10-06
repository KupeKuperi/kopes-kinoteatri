# moviebox-tui v0.1.26 in Kope's Kinoteatri for iPhone

The iPhone core (`ios/core`, crate kino-core) uses this source as the library `moviebox_tui`.
Every change to the upstream source is listed here (file, what, why), so that a newer upstream
version can be merged by re-applying them.

## Changes

- `src/net.rs` `http_client_builder_base`: on iOS (`target_os = "ios"`) the client keeps reqwest's
  default resolver (getaddrinfo) instead of `FallbackResolver`. Why: an iOS app can't read the
  phone's DNS setup (`/etc/resolv.conf`), so hickory's system config fails there and every lookup
  would go to public DNS: no VPN DNS, and no NAT64 address synthesis on IPv6-only mobile networks,
  where IPv4-only hosts then can't be reached. getaddrinfo asks the system resolver, which handles
  all of that. Other platforms are unchanged. (2026-10-07)

## What kino-core relies on

Check these when merging a newer upstream; `ios/core/src/engine.rs` calls them as they are:

- `service::MovieBoxService` (`new`, the `client` field, `get_ext_captions`, `Clone`), `service::metric_value`
- `providers::moviebox::client::MovieBoxClient` (`init`, `search`, `get_details`) and its
  `providers::ReleaseProvider::episode_streams`
- `providers::moviebox::adapt` (`moviebox_search_json_to_catalog`, `moviebox_details_json_to_media_details`),
  `providers::moviebox::clean_moviebox_title`
- `providers::models` (`MediaDetails` with `is_series` / `has_languages` / `sibling_ids`, `Release` with
  `direct_url` / `source_label` / `resolution_u64`, `PlaybackSource`, `ProviderError::user_message`,
  `clean_stream_text`)
- `cache` (details and stream caches, `clean_old_cache_background`)
- `tui::screens::details::clean_stream_release_title`, `tui::text::sanitize_language_label`

engine.rs also follows TUI logic it can't call (it lives in the TUI's event handlers):
`tui/app/requests.rs` (SearchSuccess, DetailsSuccess, StreamPoolInitialized, FetchEpisodeStreams,
EpisodeStreamsReady/Failed), `tui/app/playback.rs` (PlayStream), `tui/app/navigation.rs` (the
subtitle choice), and a copy of the private `tui/screens/details.rs` `clean_language_name`.

## Upstream issues seen (left as they are)

- `cache.rs` `edge_cache_cookie_expiry` reads the `t=` of MovieBox's `Edge-Cache-Cookie` as an expiry.
  It is the signing time (about 10 minutes old when a stream list arrives), so MovieBox stream lists
  are never reused from the disk cache: every stream list is fetched again (harmless, ~0.2 s).
- `providers/moviebox/adapt.rs` reads `genre` as a list; MovieBox sends one comma-separated string,
  so genres come out empty (kino-core splits the string itself).
