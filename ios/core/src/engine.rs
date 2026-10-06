//! The engine (moviebox-tui v0.1.26, `ios/engine`) as the core uses it, for MovieBox: search,
//! details, streams, and resolving a stream to what the engine would hand a video player.
//! OWNER: agent "engine" (see GUIDE.md).
//!
//! Every step mirrors what the TUI does for it (each function names the TUI code it follows), minus
//! the terminal: no players, no proxy sidecar, no child processes (iOS allows none). The engine's
//! disk caches (details, stream lists with their signed cookies, captions, the MovieBox session)
//! live where `kino_core::start` points `MOVIEBOX_*_DIR`.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use moviebox_tui::cache;
use moviebox_tui::providers::ReleaseProvider;
use moviebox_tui::providers::models::{
    Episode, MediaDetails, MediaType, PlaybackSource, ProviderError, ProviderKind, Release, clean_stream_text,
};
use moviebox_tui::providers::moviebox::{adapt, clean_moviebox_title};
use moviebox_tui::service::MovieBoxService;
use moviebox_tui::tui::screens::details::clean_stream_release_title;
use moviebox_tui::tui::text::sanitize_language_label;
use serde_json::Value;

use crate::api::{AudioTrack, Details, EpisodeInfo, SeasonInfo, Source, Stream, Title};

pub const ENGINE_VERSION: &str = "0.1.26";

const PROVIDER: ProviderKind = ProviderKind::MovieBox;

/// How long the TUI waits for the subtitle list before playing without subtitles.
const CAPTIONS_TIMEOUT: Duration = Duration::from_secs(15);

/// Titles and stream lists kept in memory; past this the memory is emptied (they're refetched).
const MEMORY_LIMIT: usize = 256;

type StreamKey = (String, usize, usize);

struct Engine {
    service: MovieBoxService,
    /// Details by subject id: titles, kind, and the dubs whose ids caption lookups include.
    details: Mutex<HashMap<String, MediaDetails>>,
    /// The lists `streams` handed out, by (id, season, episode): `resolve`'s index points into them.
    streams: Mutex<HashMap<StreamKey, Vec<Release>>>,
}

static ENGINE: OnceLock<Engine> = OnceLock::new();

fn engine() -> Result<&'static Engine, String> {
    ENGINE.get().ok_or_else(|| "The engine isn't started.".to_string())
}

/// A poisoned lock only means another request panicked mid-update; its map is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Creates the engine's service. Then, like the TUI at startup (main.rs, tui/app/run.rs), logs in
/// to MovieBox and prunes week-old cache files in the background: an offline start still
/// succeeds, and the first request logs in if this one couldn't.
pub async fn init() -> Result<(), String> {
    let engine = ENGINE.get_or_init(|| Engine {
        service: MovieBoxService::new(),
        details: Mutex::default(),
        streams: Mutex::default(),
    });
    let client = engine.service.client.clone();
    tokio::spawn(async move {
        if let Err(e) = client.init().await {
            log::warn!("MovieBox login deferred: {e}");
        }
    });
    cache::clean_old_cache_background();
    Ok(())
}

// ── Search ───────────────────────────────────────────────────────────────────

/// MovieBox search, first page, listed like the TUI lists it (tui/app/requests.rs SearchSuccess):
/// cleaned titles, only titles that contain the query, dubs and repeats folded into one entry,
/// then exact matches, prefix matches, series before films, newest first.
///
/// One difference: where a dub and its original fold into one entry, the entry keeps the
/// original's id. MovieBox tends to list "Title [Hindi]" before "Title"; the TUI keeps the first
/// and then its Audio pane pre-selects Original before loading streams, so this lands where the
/// TUI does without that extra step.
pub async fn search(query: &str) -> Result<Vec<Title>, String> {
    let engine = engine()?;
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    // `Provider::search` is this call plus the adapter below; the raw answer also has ratings.
    let payload = engine
        .service
        .client
        .search(query, 1)
        .await
        .map_err(|e| ProviderError::from(e).user_message(PROVIDER))?;
    let ratings = search_ratings(&payload);

    struct Hit {
        title: Title,
        series: bool,
        year: String,
        dub: bool,
    }
    let wanted = alphanumeric_lowercase(query);
    let mut hits: Vec<Hit> = Vec::new();
    for item in adapt::moviebox_search_json_to_catalog(&payload) {
        let id = item.id.value;
        if id.is_empty() || hits.iter().any(|h| h.title.id == id) {
            continue;
        }
        if !wanted.is_empty() && !alphanumeric_lowercase(&item.title).contains(&wanted) {
            continue;
        }
        let title = clean_moviebox_title(&item.title).to_string();
        let series = item.media_type == MediaType::Series;
        let year = item.year.clone().unwrap_or_default();
        let raw = item.title.to_lowercase();
        let dub = ["[hindi]", "[tamil]", "[telugu]", "[english]"].iter().any(|tag| raw.contains(tag));
        if dub && hits.iter().any(|h| h.title.title == title && h.series == series) {
            continue;
        }
        let rating = ratings.get(&id).cloned();
        let twin = hits.iter_mut().find(|h| h.title.title == title && h.year == year && h.series == series);
        if let Some(twin) = twin {
            if twin.dub && !dub {
                twin.title.id = id;
                twin.title.poster = item.poster_url.or(twin.title.poster.take());
                twin.title.rating = rating.or(twin.title.rating.take());
                twin.dub = false;
            }
            continue;
        }
        hits.push(Hit {
            title: Title {
                id,
                title,
                year: item.year.filter(|y| !y.trim().is_empty()),
                kind: if series { "series" } else { "movie" }.to_string(),
                poster: item.poster_url,
                rating,
            },
            series,
            year,
            dub,
        });
    }

    let query_lower = query.to_lowercase();
    hits.sort_by(|a, b| {
        let (a_title, b_title) = (a.title.title.to_lowercase(), b.title.title.to_lowercase());
        (b_title == query_lower)
            .cmp(&(a_title == query_lower))
            .then_with(|| b_title.starts_with(&query_lower).cmp(&a_title.starts_with(&query_lower)))
            .then_with(|| b.series.cmp(&a.series))
            .then_with(|| b.year.cmp(&a.year))
    });
    Ok(hits.into_iter().map(|h| h.title).collect())
}

/// The TUI matches titles on letters and digits only ("Spider-Man" finds "Spiderman").
fn alphanumeric_lowercase(text: &str) -> String {
    text.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// IMDb ratings by subject id, read from the same subject lists the engine's search adapter reads.
fn search_ratings(payload: &Value) -> HashMap<String, String> {
    let field = |key: &str| payload.get("data").and_then(|d| d.get(key)).or_else(|| payload.get(key));
    let subjects = field("results")
        .and_then(Value::as_array)
        .and_then(|groups| groups.first())
        .and_then(|group| group.get("subjects"))
        .and_then(Value::as_array)
        .or_else(|| field("list").and_then(Value::as_array));
    let mut ratings = HashMap::new();
    for subject in subjects.map(Vec::as_slice).unwrap_or_default() {
        let id = subject.get("subjectId").or_else(|| subject.get("id")).and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        });
        let keys = ["imdbRatingValue", "imdbRate", "imdb_rating", "imdbRating"];
        let rating = moviebox_tui::service::metric_value(subject, &keys);
        if let (Some(id), Some(rating)) = (id, rating.filter(|r| *r > 0.0)) {
            ratings.insert(id, format!("{rating:.1}"));
        }
    }
    ratings
}

// ── Details ──────────────────────────────────────────────────────────────────

/// A title's details as the TUI's details screen shows them (tui/app/requests.rs DetailsSuccess,
/// tui/screens/details.rs): cleaned title; a series without a season list gets season 1 episode 1;
/// the dubs as the Audio pane lists them, only when there is more than one.
pub async fn details(id: &str) -> Result<Details, String> {
    let details = load_details(id).await?;
    let seasons = if !details.seasons.is_empty() {
        details
            .seasons
            .iter()
            .map(|season| SeasonInfo {
                season: season.number,
                episodes: if season.episodes.is_empty() {
                    vec![EpisodeInfo { episode: 1, title: None }]
                } else {
                    let info = |e: &Episode| EpisodeInfo { episode: e.number, title: e.title.clone() };
                    season.episodes.iter().map(info).collect()
                },
            })
            .collect()
    } else if details.media_type == MediaType::Series {
        vec![SeasonInfo { season: 1, episodes: vec![EpisodeInfo { episode: 1, title: None }] }]
    } else {
        Vec::new()
    };
    let audio = if details.has_languages() {
        details
            .dubs
            .iter()
            .filter(|dub| !dub.subject_id.is_empty())
            .map(|dub| AudioTrack { id: dub.subject_id.clone(), label: dub_label(&dub.language) })
            .collect()
    } else {
        Vec::new()
    };
    let known = |value: &Option<String>| value.clone().filter(|v| !v.trim().is_empty() && v != "N/A");
    Ok(Details {
        id: id.to_string(),
        title: clean_moviebox_title(&details.title).to_string(),
        year: known(&details.year),
        kind: if details.is_series() { "series" } else { "movie" }.to_string(),
        description: known(&details.description),
        poster: details.poster_url.clone(),
        rating: known(&details.imdb_rating).filter(|r| r.parse::<f64>().map_or(true, |v| v > 0.0)),
        duration: known(&details.duration),
        genres: details.genres.clone(),
        seasons,
        audio,
    })
}

/// The engine's details for a subject: from memory, else its disk cache (a day, like the TUI's
/// run_details_request), else MovieBox. A dub's own details are often bare; like DetailsSuccess,
/// they're completed from the title that lists the dub.
async fn load_details(id: &str) -> Result<MediaDetails, String> {
    let engine = engine()?;
    let remembered = lock(&engine.details).get(id).cloned();
    if let Some(details) = remembered {
        return Ok(details);
    }
    let key = id.to_string();
    let cached = tokio::task::spawn_blocking(move || cache::get_provider_details_cache_typed(PROVIDER, &key));
    let mut details = match cached.await.ok().flatten() {
        Some(details) => details,
        None => {
            // What `service.details_typed` does for MovieBox (Provider::details), plus the genres:
            // MovieBox sends them as one "Action, Drama" string, which the adapter (expecting a
            // list) drops.
            let json = engine.service.client.get_details(id).await;
            let json = json.map_err(|e| ProviderError::from(e).user_message(PROVIDER))?;
            let fresh = adapt::moviebox_details_json_to_media_details(&json);
            let mut fresh = fresh.map_err(|e| e.user_message(PROVIDER))?;
            if fresh.genres.is_empty() {
                fresh.genres = genre_list(&json);
            }
            let (key, value) = (id.to_string(), fresh.clone());
            let save = move || cache::set_provider_details_cache_typed(PROVIDER, &key, &value);
            let _ = tokio::task::spawn_blocking(save).await;
            fresh
        }
    };
    let mut memory = lock(&engine.details);
    let lists_this_dub = |d: &&MediaDetails| d.id.value != id && d.dubs.iter().any(|dub| dub.subject_id == id);
    if let Some(parent) = memory.values().find(lists_this_dub) {
        complete_from_parent(&mut details, parent);
    }
    if memory.len() >= MEMORY_LIMIT {
        memory.clear();
    }
    memory.insert(id.to_string(), details.clone());
    Ok(details)
}

/// The genres of a details answer given as one comma-separated string (where the adapter looks).
fn genre_list(json: &Value) -> Vec<String> {
    let subject = json.get("data").and_then(|d| d.get("subject"));
    let subject = subject.or_else(|| json.get("subject")).unwrap_or(json);
    let genres = subject.get("genre").or_else(|| subject.get("genres")).and_then(Value::as_str).unwrap_or("");
    genres.split(',').map(str::trim).filter(|g| !g.is_empty()).map(str::to_string).collect()
}

/// DetailsSuccess (tui/app/requests.rs) after a dub switch: keep the listing title's name when it's
/// the same title, and take whatever the dub's details lack from it.
fn complete_from_parent(details: &mut MediaDetails, parent: &MediaDetails) {
    let same_name = clean_moviebox_title(&details.title) == clean_moviebox_title(&parent.title);
    if details.title.trim().is_empty() || (!parent.title.trim().is_empty() && same_name) {
        details.title = parent.title.clone();
    }
    let title = clean_moviebox_title(&details.title).to_string();
    let placeholder = |desc: &Option<String>| {
        desc.as_ref().is_none_or(|d| {
            let d = d.trim();
            d.is_empty() || d == "N/A" || clean_moviebox_title(d) == title
        })
    };
    if placeholder(&details.description) && !placeholder(&parent.description) {
        details.description = parent.description.clone();
    }
    let missing = |value: &Option<String>| value.as_deref().is_none_or(|v| v.is_empty() || v == "N/A");
    if details.poster_url.is_none() {
        details.poster_url = parent.poster_url.clone();
    }
    if missing(&details.year) {
        details.year = parent.year.clone();
    }
    if missing(&details.duration) {
        details.duration = parent.duration.clone();
    }
    if details.genres.is_empty() {
        details.genres = parent.genres.clone();
    }
    if missing(&details.imdb_rating) {
        details.imdb_rating = parent.imdb_rating.clone();
    }
    if missing(&details.director) {
        details.director = parent.director.clone();
    }
    if missing(&details.stars) {
        details.stars = parent.stars.clone();
    }
    if details.dubs.is_empty() {
        details.dubs = parent.dubs.clone();
    }
}

/// A dub's name as the TUI's Audio pane shows it (tui/screens/details.rs clean_language_name,
/// private upstream, so copied here).
fn dub_label(language: &str) -> String {
    let name = if language.to_ascii_lowercase().starts_with("original") {
        "Original".to_string()
    } else if language.eq_ignore_ascii_case("dub") {
        "English Dub".to_string()
    } else {
        language.replace("dub", "").replace("Dub", "").trim().to_string()
    };
    if name.eq_ignore_ascii_case("ptbr") {
        "Portuguese (BR)".to_string()
    } else if name.eq_ignore_ascii_case("esla") {
        "Spanish (LA)".to_string()
    } else {
        name
    }
}

// ── Streams ──────────────────────────────────────────────────────────────────

/// The releases the TUI's Streams pane lists for a film (0/0) or an episode, best first; the
/// list is remembered per (id, season, episode) so `resolve` plays the one the app showed, and
/// the captions are fetched ahead like the TUI does.
pub async fn streams(id: &str, season: usize, episode: usize) -> Result<Vec<Stream>, String> {
    let (season, episode) = episode_key(id, season, episode).await;
    let releases = fetch_streams(id, season, episode).await?;
    warm_captions(engine()?, id, season, episode, &releases);
    let media_title = load_details(id).await.map(|d| d.title).unwrap_or_default();
    Ok(releases
        .iter()
        .enumerate()
        .map(|(index, release)| Stream {
            index,
            quality: release.quality.clone(),
            size_bytes: release.size_bytes,
            codec: release.codec.clone(),
            audio: release.language.clone(),
            label: release_label(release, &media_title),
        })
        .collect())
}

/// The episode the TUI asks streams for (tui/app/requests.rs StreamPoolInitialized): 0/0 for a
/// film, at least 1/1 for a series. Without details, what was asked.
async fn episode_key(id: &str, season: usize, episode: usize) -> (usize, usize) {
    match load_details(id).await {
        Ok(details) if details.is_series() => (season.max(1), episode.max(1)),
        Ok(_) => (0, 0),
        Err(_) => (season, episode),
    }
}

/// The TUI's stream fetch (tui/app/requests.rs FetchEpisodeStreams, EpisodeStreamsReady): the
/// engine's disk cache while its signed cookies are fresh, else MovieBox (play-info plus the
/// resource list); settled the TUI's way; cached on disk and in memory.
async fn fetch_streams(id: &str, season: usize, episode: usize) -> Result<Vec<Release>, String> {
    let engine = engine()?;
    let raw = match disk_streams(id, season, episode).await {
        Some(cached) => cached,
        None => ReleaseProvider::episode_streams(&engine.service.client, id, season, episode)
            .await
            .map_err(|e| streams_error(&e.to_string()))?,
    };
    let releases = settle_streams(raw, season, episode);
    if releases.is_empty() {
        return Err(streams_error("No stream sources"));
    }
    let (key, value) = (id.to_string(), releases.clone());
    let save = move || cache::set_provider_stream_cache_typed(PROVIDER, &key, season, episode, &value);
    let _ = tokio::task::spawn_blocking(save).await;
    {
        let mut memory = lock(&engine.streams);
        let key = (id.to_string(), season, episode);
        if memory.len() >= MEMORY_LIMIT && !memory.contains_key(&key) {
            memory.clear();
        }
        memory.insert(key, releases.clone());
    }
    Ok(releases)
}

/// The engine's stream cache for an episode; None once it expired or its signed cookies expire
/// within a minute (cache::get_provider_stream_cache_typed).
async fn disk_streams(id: &str, season: usize, episode: usize) -> Option<Vec<Release>> {
    let id = id.to_string();
    let load = move || cache::get_provider_stream_cache_typed(PROVIDER, &id, season, episode);
    tokio::task::spawn_blocking(load).await.ok().flatten()
}

/// EpisodeStreamsReady: releases filed under the asked episode (a film's all under 0/0, unnumbered
/// ones under the asked episode), MovieBox duplicates dropped (same address without its query and
/// same quality, or same file name), highest resolution first.
fn settle_streams(raw: Vec<Release>, season: usize, episode: usize) -> Vec<Release> {
    let mut settled: Vec<Release> = Vec::new();
    for mut item in raw {
        let (mut se, mut ep) = (item.season.unwrap_or(0), item.episode.unwrap_or(0));
        if season == 0 && episode == 0 {
            (se, ep) = (0, 0);
        } else if se == 0 && ep == 0 {
            (se, ep) = (season, episode);
        }
        if (se, ep) != (season, episode) {
            continue;
        }
        (item.season, item.episode) = (Some(se), Some(ep));
        let link = item.direct_url().unwrap_or("");
        let base = link.split('?').next().unwrap_or(link).to_string();
        let duplicate = settled.iter_mut().find(|i| {
            let other = i.direct_url().unwrap_or("");
            let other_base = other.split('?').next().unwrap_or(other);
            let same_url = !base.is_empty() && base == other_base && item.quality == i.quality;
            same_url || (!item.filename.is_empty() && item.filename == i.filename)
        });
        match duplicate {
            Some(existing) => {
                if !item.mirrors.is_empty() && existing.mirrors.is_empty() {
                    existing.mirrors = item.mirrors;
                }
            }
            None => settled.push(item),
        }
    }
    settled.sort_by_key(|r| Reverse(r.resolution_u64()));
    settled
}

/// EpisodeStreamsFailed's wording.
fn streams_error(err: &str) -> String {
    if err.contains("No stream sources") {
        format!("No streams available on {}.", PROVIDER.label())
    } else if let Some(reason) = err.strip_prefix("Provider is temporarily unavailable: ") {
        reason.to_string()
    } else {
        err.to_string()
    }
}

/// Like EpisodeStreamsReady, fetches the first release's captions in the background, so `play`
/// with subtitles finds them in the engine's caption cache.
fn warm_captions(engine: &Engine, id: &str, season: usize, episode: usize, releases: &[Release]) {
    let Some(resource_id) = releases.first().and_then(|r| r.resource_id.clone()) else {
        return;
    };
    let service = engine.service.clone();
    let siblings = lock(&engine.details).get(id).map(MediaDetails::sibling_ids).unwrap_or_default();
    let id = id.to_string();
    tokio::spawn(async move {
        let _ = service.get_ext_captions(&id, &resource_id, &siblings, season, episode).await;
    });
}

/// A release's name in the TUI's Streams pane (RELEASE column, tui/screens/details.rs): the file
/// name without codec and resolution, or where it only repeats the title, the uploader
/// ("MovieBox CDN" for MovieBox's own copies).
fn release_label(release: &Release, media_title: &str) -> String {
    const NOT_A_NAME: [&str; 12] =
        ["multi", "res", "hevc", "h264", "x265", "x264", "1080p", "720p", "480p", "360p", "4k", "direct"];
    let source = clean_stream_text(release.source_label());
    let redundant_source = {
        let lower = source.to_ascii_lowercase();
        let mut parts = lower.split(|c: char| c == '-' || c.is_whitespace()).filter(|p| !p.is_empty()).peekable();
        parts.peek().is_some() && parts.all(|p| NOT_A_NAME.contains(&p))
    };
    let uploader = if !source.is_empty() && !redundant_source { source } else { "MovieBox CDN".to_string() };
    let name = clean_stream_release_title(&release.filename);
    if !media_title.is_empty() && name.eq_ignore_ascii_case(media_title) { uploader } else { name }
}

// ── Playing ──────────────────────────────────────────────────────────────────

/// What the engine hands a video player for one stream (its `PlaybackSource`: address, headers,
/// subtitle file, the quality as a height cap) and the title to show while it plays.
pub struct Playback {
    pub source: PlaybackSource,
    pub title: String,
}

/// `playback` in the core's contract shape. The quality goes along as `max_height`: for MovieBox
/// all qualities of a film are the same DASH manifest, the cap is what picks among them. The
/// subtitle language goes along only when a subtitle file was found in it.
pub async fn resolve(
    id: &str,
    season: usize,
    episode: usize,
    stream: usize,
    subtitles: Option<&str>,
) -> Result<Source, String> {
    let Playback { source, title } = playback(id, season, episode, stream, subtitles).await?;
    let subtitle_lang = source.subtitle.as_ref().and(subtitles.map(str::trim).filter(|l| !l.is_empty())).map(str::to_string);
    Ok(Source { url: source.url, headers: source.headers, subtitle_url: source.subtitle, subtitle_lang, title, max_height: source.max_height })
}

/// Starts stream `stream` of `streams(id, season, episode)` the way the TUI starts a MovieBox
/// release (tui/app/playback.rs PlayStream, then the subtitle choice in tui/app/navigation.rs
/// Submit): the release's first mirror with its headers (Referer, User-Agent, the CDN cookie), its
/// resolution as the player's height cap, and the subtitle language picked from the engine's
/// captions for the release and its dubs. From there the TUI only launches a player.
pub async fn playback(
    id: &str,
    season: usize,
    episode: usize,
    stream: usize,
    subtitles: Option<&str>,
) -> Result<Playback, String> {
    let (season, episode) = episode_key(id, season, episode).await;
    let release = pick_release(id, season, episode, stream).await?;
    let mirror = release.mirrors.first().ok_or("No playable mirrors were found for this release.")?;
    let mut source = PlaybackSource {
        provider: release.provider,
        url: mirror.resolver_url.clone(),
        headers: mirror.headers.clone(),
        subtitle: None,
        source_label: mirror.label.clone(),
        max_height: Some(release.resolution_u64()).filter(|&h| h > 0),
    };
    let language = subtitles.map(str::trim).filter(|l| !l.is_empty());
    if let (Some(language), Some(resource_id)) = (language, release.resource_id.as_deref()) {
        source.subtitle = find_subtitle(id, resource_id, season, episode, language).await;
    }
    let title = match load_details(id).await {
        Ok(details) => clean_moviebox_title(&details.title).to_string(),
        Err(_) => clean_stream_release_title(&release.filename),
    };
    // The TUI's name for an episode's subtitle file and history entry.
    let title = if season > 0 || episode > 0 { format!("{title} - S{season:02}E{episode:02}") } else { title };
    Ok(Playback { source, title })
}

/// The release the app picked from the list `streams` gave it (fetched now if it never asked).
/// Signed CDN cookies expire: when the engine's stream cache says the list went stale, it's fetched
/// again and the same release (file name and quality) is taken from the new list. MovieBox's
/// Edge-Cache-Cookie carries its signing time (`t=`), which the engine's cache reads as an expiry,
/// so for those the list is always fetched again here: every play starts with a fresh cookie.
async fn pick_release(id: &str, season: usize, episode: usize, stream: usize) -> Result<Release, String> {
    let engine = engine()?;
    let remembered = lock(&engine.streams).get(&(id.to_string(), season, episode)).cloned();
    let (list, just_fetched) = match remembered {
        Some(list) => (list, false),
        None => (fetch_streams(id, season, episode).await?, true),
    };
    let chosen = list
        .get(stream)
        .cloned()
        .ok_or_else(|| format!("There is no stream {stream} ({} listed).", list.len()))?;
    if just_fetched || disk_streams(id, season, episode).await.is_some() {
        return Ok(chosen);
    }
    match fetch_streams(id, season, episode).await {
        Ok(fresh) => {
            let same = fresh.into_iter().find(|r| r.filename == chosen.filename && r.quality == chosen.quality);
            Ok(same.unwrap_or(chosen))
        }
        Err(e) => {
            log::warn!("stream list refresh failed ({e}); playing the remembered one");
            Ok(chosen)
        }
    }
}

/// The subtitle file for a language as the TUI's subtitle list names it (sanitize_language_label,
/// so "English", "eng" and "en" are one), from the engine's captions for the release and its dubs.
/// Like the TUI, a slow or failed caption lookup means playing without subtitles.
async fn find_subtitle(
    id: &str,
    resource_id: &str,
    season: usize,
    episode: usize,
    language: &str,
) -> Option<String> {
    let engine = engine().ok()?;
    let siblings = load_details(id).await.map(|d| d.sibling_ids()).unwrap_or_default();
    let lookup = engine.service.get_ext_captions(id, resource_id, &siblings, season, episode);
    let captions = match tokio::time::timeout(CAPTIONS_TIMEOUT, lookup).await {
        Ok(Ok(captions)) => captions,
        Ok(Err(e)) => {
            log::warn!("subtitles unavailable: {e}");
            return None;
        }
        Err(_) => {
            log::warn!("subtitles timed out after {}s", CAPTIONS_TIMEOUT.as_secs());
            return None;
        }
    };
    let wanted = sanitize_language_label(language);
    captions
        .into_iter()
        .find(|c| sanitize_language_label(&c.name).eq_ignore_ascii_case(&wanted))
        .map(|c| c.url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use moviebox_tui::providers::models::SourceMirror;

    fn release(filename: &str, quality: &str, url: &str, se: Option<usize>, ep: Option<usize>) -> Release {
        Release {
            provider: ProviderKind::MovieBox,
            filename: filename.into(),
            quality: Some(quality.into()),
            codec: Some("hevc".into()),
            language: None,
            size_bytes: None,
            season: se,
            episode: ep,
            mirrors: vec![SourceMirror {
                label: format!("{quality} hevc"),
                resolver_url: url.into(),
                headers: vec![],
                direct_file: true,
            }],
            resource_id: Some("1".into()),
        }
    }

    #[test]
    fn settling_keeps_the_episode_drops_duplicates_and_sorts() {
        let raw = vec![
            release("Show S01E01 480p hevc", "480p", "https://cdn/a/index.mpd?x=1", Some(1), Some(1)),
            release("Show S01E01 1080p hevc", "1080p", "https://cdn/a/index.mpd?x=1", Some(1), Some(1)),
            release("Show S01E01 1080p hevc", "1080p", "https://cdn/a/index.mpd?x=2", Some(1), Some(1)),
            release("Show.S01E02.mkv", "720p", "https://cdn/b.mkv", Some(1), Some(2)),
            release("Show.mkv", "720p", "https://cdn/c.mkv", None, None),
        ];
        let settled = settle_streams(raw, 1, 1);
        let names: Vec<&str> = settled.iter().map(|r| r.filename.as_str()).collect();
        assert_eq!(names, ["Show S01E01 1080p hevc", "Show.mkv", "Show S01E01 480p hevc"]);
        assert!(settled.iter().all(|r| (r.season, r.episode) == (Some(1), Some(1))));
    }

    #[test]
    fn a_film_files_everything_under_zero() {
        let raw = vec![release("Film 720p hevc", "720p", "https://cdn/f/index.mpd", Some(3), Some(4))];
        let settled = settle_streams(raw, 0, 0);
        assert_eq!(settled.len(), 1);
        assert_eq!((settled[0].season, settled[0].episode), (Some(0), Some(0)));
    }

    #[test]
    fn labels_follow_the_streams_pane() {
        let own_copy = release("The Film 1080p hevc", "1080p", "https://cdn/f/index.mpd", None, None);
        assert_eq!(release_label(&own_copy, "The Film"), "MovieBox CDN");
        let mut upload = release("The.Film.2001.1080p.BluRay.x265", "1080p", "https://cdn/f.mkv", None, None);
        upload.mirrors[0].label = "Direct".into();
        assert_eq!(release_label(&upload, "The Film"), "The.Film.2001.1080p.BluRay");
    }

    #[test]
    fn dub_labels_follow_the_audio_pane() {
        assert_eq!(dub_label("Original Audio"), "Original");
        assert_eq!(dub_label("dub"), "English Dub");
        assert_eq!(dub_label("Hindi dub"), "Hindi");
        assert_eq!(dub_label("ptbr"), "Portuguese (BR)");
    }

    #[test]
    fn genres_come_from_the_comma_separated_string() {
        let json = serde_json::json!({"subjectId": "1", "genre": "Adventure, Drama,Fantasy"});
        assert_eq!(genre_list(&json), ["Adventure", "Drama", "Fantasy"]);
        assert!(genre_list(&serde_json::json!({"genre": ""})).is_empty());
    }

    #[test]
    fn search_ratings_read_both_answer_shapes() {
        let subjects = [
            serde_json::json!({"subjectId": "7", "imdbRatingValue": "8.8"}),
            serde_json::json!({"subjectId": 9, "imdbRatingValue": 0}),
        ];
        let grouped = serde_json::json!({"results": [{"subjects": subjects}]});
        let ratings = search_ratings(&grouped);
        assert_eq!(ratings.get("7").map(String::as_str), Some("8.8"));
        assert!(!ratings.contains_key("9"));
        let listed = serde_json::json!({"list": [{"id": "5", "imdbRate": 7.3}]});
        assert_eq!(search_ratings(&listed).get("5").map(String::as_str), Some("7.3"));
    }
}
