/** Controlled vocabularies, served to the web app from GET /api/meta. */

export const SERIES_TYPES = [
  { id: 'comic', label: 'Comic' },
  { id: 'graphic_novel', label: 'Graphic Novel' },
  { id: 'manga', label: 'Manga' },
  { id: 'webcomic', label: 'Webcomic' },
] as const;

export const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Fantasy', 'Historical', 'Horror', 'Mystery',
  'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Superhero', 'Supernatural', 'Thriller', 'War', 'Western',
  'Non-Fiction', 'Anthology', 'Kids',
] as const;

export const THEMES = [
  'Aliens', 'Alternate History', 'Anti-Hero', 'Coming of Age', 'Cyberpunk', 'Dystopia', 'Espionage', 'Family',
  'Found Family', 'Friendship', 'Gods & Mythology', 'Heist', 'Isekai', 'Kaiju', 'LGBTQ+', 'Magic', 'Martial Arts',
  'Mecha', 'Military', 'Monsters', 'Noir', 'Occult', 'Pirates', 'Political', 'Post-Apocalyptic', 'Pulp', 'Revenge',
  'Robots', 'Satire', 'Space Opera', 'Steampunk', 'Survival', 'Sword & Sorcery', 'Time Travel', 'Vampires',
  'Vigilante', 'Zombies',
] as const;

export const ERAS = [
  'Prehistoric', 'Ancient', 'Medieval', 'Renaissance', '18th Century', '19th Century', 'World War I',
  'World War II', 'Cold War', 'Modern Day', 'Near Future', 'Far Future', 'Timeless',
] as const;

export const AUDIENCES = ['All Ages', 'Kids', 'Teen', 'Young Adult', 'Adult', 'Mature 18+'] as const;

export const ART_STYLES = [
  'American Mainstream', 'Black & White', 'Cartoon', 'Chibi', 'Digital Painting', 'European / BD', 'Indie / Alt',
  'Manga', 'Manhwa', 'Minimalist', 'Painted', 'Photorealistic', 'Pixel Art', 'Retro / Golden Age', 'Sketch', 'Watercolor',
] as const;

export const ADVISORIES = [
  'Violence', 'Graphic Violence', 'Gore', 'Strong Language', 'Nudity', 'Sexual Content', 'Drug Use',
  'Historical Imagery', 'Disturbing Themes', 'Flashing Imagery',
] as const;

export const CONTENT_RATINGS = ['Everyone', 'Teen', 'Teen+', 'Mature', 'Adults Only'] as const;

export const UPDATE_FREQUENCIES = ['None', 'Daily', 'Weekly', 'Biweekly', 'Monthly', 'Bimonthly', 'Quarterly', 'Irregular'] as const;

export const SERIES_STATUSES = ['ongoing', 'completed', 'hiatus', 'cancelled'] as const;

/** Release types grouped the way the release dialog shows them. Each type keeps its own numbering. */
export const RELEASE_GROUPS = [
  { group: 'Singles', kinds: [{ id: 'issue', label: 'Issue' }, { id: 'omake', label: 'Omake' }, { id: 'special', label: 'Special' }] },
  { group: 'Verticals', kinds: [{ id: 'episode', label: 'Episode' }] },
  { group: 'One-shots', kinds: [{ id: 'one_shot', label: 'One-shot' }] },
  {
    group: 'Volumes',
    kinds: [
      { id: 'graphic_novel', label: 'Graphic Novel' },
      { id: 'bande_dessinee', label: 'Bande Dessinée' },
      { id: 'volume', label: 'Volume' },
    ],
  },
  { group: 'Omnibuses', kinds: [{ id: 'omnibus', label: 'Omnibus' }] },
  { group: 'Compendiums', kinds: [{ id: 'compendium', label: 'Compendium' }] },
] as const;

export const RELEASE_KINDS = RELEASE_GROUPS.flatMap((g) => g.kinds.map((k) => k.id)) as string[];

export const CONTRIBUTOR_ROLES = [
  'Writer', 'Artist', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'Cover Artist', 'Editor', 'Translator', 'Creator', 'Designer',
] as const;

export const CROWDFUNDING_SERVICES = ['IndieCrowdfund', 'Kickstarter', 'Indiegogo', 'BackerKit', 'Zoop', 'Crowdfundr', 'Other'] as const;

export const FAVORITE_GENRES = [
  { id: 'superhero_action', label: 'Superhero & Action', genres: ['Superhero', 'Action'] },
  { id: 'scifi_fantasy', label: 'Sci-Fi & Fantasy', genres: ['Sci-Fi', 'Fantasy'] },
  { id: 'manga_action', label: 'Manga, Action & Adventure', genres: ['Action', 'Adventure'], type: 'manga' },
  { id: 'manga_romance', label: 'Manga, Romance & Fantasy', genres: ['Romance', 'Fantasy'], type: 'manga' },
  { id: 'horror_mystery', label: 'Horror & Mystery', genres: ['Horror', 'Mystery', 'Thriller'] },
  { id: 'everything', label: 'A little bit of everything', genres: [] },
] as const;

export const LANGUAGES = [
  { code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' }, { code: 'it', label: 'Italian' }, { code: 'pt', label: 'Portuguese' },
  { code: 'ja', label: 'Japanese' }, { code: 'ko', label: 'Korean' }, { code: 'zh', label: 'Chinese' },
  { code: 'ru', label: 'Russian' }, { code: 'pl', label: 'Polish' }, { code: 'nl', label: 'Dutch' },
  { code: 'tr', label: 'Turkish' }, { code: 'id', label: 'Indonesian' }, { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' }, { code: 'tl', label: 'Filipino' }, { code: 'vi', label: 'Vietnamese' },
] as const;

export const FORUM_BOARDS = [
  { id: 'general', label: 'General' },
  { id: 'recommendations', label: 'Recommendations' },
  { id: 'creators', label: 'Creator Corner' },
  { id: 'feedback', label: 'Site Feedback' },
] as const;

export function meta() {
  return {
    seriesTypes: SERIES_TYPES, genres: GENRES, themes: THEMES, eras: ERAS, audiences: AUDIENCES, artStyles: ART_STYLES,
    advisories: ADVISORIES, contentRatings: CONTENT_RATINGS, updateFrequencies: UPDATE_FREQUENCIES,
    seriesStatuses: SERIES_STATUSES, releaseGroups: RELEASE_GROUPS, contributorRoles: CONTRIBUTOR_ROLES,
    crowdfundingServices: CROWDFUNDING_SERVICES, favoriteGenres: FAVORITE_GENRES, languages: LANGUAGES, forumBoards: FORUM_BOARDS,
  };
}
