import {
	App,
	FuzzySuggestModal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	moment,
} from "obsidian";
import { getDailyNoteSettings } from "obsidian-daily-notes-interface";

// ---------- Settings ----------

type Provider = "google" | "immich" | "ask";

interface PhotoSearchSettings {
	provider: Provider;
	immichBaseUrl: string;
	/** Moment format used to parse daily-note filenames. Empty = use Daily Notes plugin setting. */
	dateFormat: string;
	/** Extra formats to try when parsing linked note names, comma-separated. */
	extraFormats: string;
}

const DEFAULT_SETTINGS: PhotoSearchSettings = {
	provider: "ask",
	immichBaseUrl: "",
	dateFormat: "",
	extraFormats: "YYYY-MM-DD, YYYY-MM-DD dddd, MMMM D, YYYY",
};

// ---------- URL generation (the secret sauce) ----------

/**
 * Google Photos has no documented date-filter URL params, but the /search/
 * endpoint accepts natural-language dates. "June 5, 2024" reliably returns
 * that day. Because it's an https link, Android App Links / iOS Universal
 * Links hand it to the Google Photos app on mobile when installed.
 */
export function googlePhotosUrl(date: moment.Moment): string {
	const query = date.format("MMMM D, YYYY");
	return `https://photos.google.com/search/${encodeURIComponent(query)}`;
}

/**
 * Immich encodes search state as JSON in the `query` param of /search.
 * takenAfter/takenBefore give exact day bounds (local-day boundaries,
 * serialized to ISO with offset so Immich resolves them correctly).
 */
export function immichUrl(baseUrl: string, date: moment.Moment): string {
	const start = date.clone().startOf("day").toISOString(true);
	const end = date.clone().endOf("day").toISOString(true);
	const q = JSON.stringify({ takenAfter: start, takenBefore: end });
	return `${baseUrl.replace(/\/+$/, "")}/search?query=${encodeURIComponent(q)}`;
}

// ---------- Date extraction ----------

interface DatedRef {
	date: moment.Moment;
	source: string; // where we found it, for the picker UI
}

function dedupe(refs: DatedRef[]): DatedRef[] {
	const seen = new Map<string, DatedRef>();
	for (const r of refs) {
		const key = r.date.format("YYYY-MM-DD");
		if (!seen.has(key)) seen.set(key, r);
	}
	return [...seen.values()].sort((a, b) => a.date.valueOf() - b.date.valueOf());
}

// ---------- Modals ----------

class DatePickerModal extends FuzzySuggestModal<DatedRef> {
	constructor(
		app: App,
		private refs: DatedRef[],
		private onPick: (ref: DatedRef) => void
	) {
		super(app);
		this.setPlaceholder("Pick a date to search photos for…");
	}
	getItems(): DatedRef[] {
		return this.refs;
	}
	getItemText(ref: DatedRef): string {
		return `${ref.date.format("YYYY-MM-DD dddd")}  (${ref.source})`;
	}
	onChooseItem(ref: DatedRef): void {
		this.onPick(ref);
	}
}

class ProviderPickerModal extends FuzzySuggestModal<Provider> {
	constructor(app: App, private choices: Provider[], private onPick: (p: Provider) => void) {
		super(app);
		this.setPlaceholder("Search where?");
	}
	getItems(): Provider[] {
		return this.choices;
	}
	getItemText(p: Provider): string {
		return p === "google" ? "Google Photos" : "Immich";
	}
	onChooseItem(p: Provider): void {
		this.onPick(p);
	}
}

// ---------- Plugin ----------

export default class PhotoSearchPlugin extends Plugin {
	settings!: PhotoSearchSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "search-current-note-date",
			name: "Search photos for this note's date",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.searchCurrentNote(file);
				return true;
			},
		});

		this.addCommand({
			id: "search-dates-in-note",
			name: "Search photos for a date mentioned in this note (links + backlinks)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.searchDatesInNote(file);
				return true;
			},
		});

		this.addSettingTab(new PhotoSearchSettingTab(this.app, this));
	}

	// --- Commands ---

	private searchCurrentNote(file: TFile) {
		const date = this.parseDate(file.basename);
		if (!date) {
			return void new Notice(
				`Couldn't parse "${file.basename}" as a date. Check the date format in settings.`
			);
		}
		this.openForDate(date);
	}

	private searchDatesInNote(file: TFile) {
		const refs: DatedRef[] = [];

		// The note itself, if it's a daily note
		const own = this.parseDate(file.basename);
		if (own) refs.push({ date: own, source: "this note" });

		// Outgoing links (resolved and unresolved)
		const cache = this.app.metadataCache.getFileCache(file);
		const linkNames = new Set<string>();
		for (const l of cache?.links ?? []) linkNames.add(l.link);
		for (const e of cache?.embeds ?? []) linkNames.add(e.link);
		// Frontmatter links (e.g. `up: [[2026-07-07]]`)
		for (const l of cache?.frontmatterLinks ?? []) linkNames.add(l.link);

		for (const name of linkNames) {
			// strip subpath/alias artifacts and folders: "Daily/2026-07-07#heading" -> "2026-07-07"
			const base = name.split("#")[0].split("|")[0].split("/").pop() ?? name;
			const d = this.parseDate(base);
			if (d) refs.push({ date: d, source: `link → ${base}` });
		}

		// Backlinks: notes that link *to* this note (public API)
		for (const [sourcePath, dests] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (!(file.path in dests)) continue;
			const base = sourcePath.split("/").pop()?.replace(/\.md$/, "") ?? sourcePath;
			const d = this.parseDate(base);
			if (d) refs.push({ date: d, source: `backlink ← ${base}` });
		}

		const unique = dedupe(refs);
		if (unique.length === 0) {
			return void new Notice("No dates found in this note's title, links, or backlinks.");
		}
		if (unique.length === 1) return this.openForDate(unique[0].date);

		new DatePickerModal(this.app, unique, (ref) => this.openForDate(ref.date)).open();
	}

	// --- Core ---

	private openForDate(date: moment.Moment) {
		const immichConfigured = this.settings.immichBaseUrl.trim().length > 0;

		const open = (p: Provider) => {
			const url =
				p === "immich"
					? immichUrl(this.settings.immichBaseUrl, date)
					: googlePhotosUrl(date);
			window.open(url); // Obsidian routes this to the system browser; mobile app links take over from there
		};

		if (this.settings.provider === "google") return open("google");
		if (this.settings.provider === "immich") {
			if (!immichConfigured) return void new Notice("Set your Immich base URL in settings.");
			return open("immich");
		}
		// "ask"
		if (!immichConfigured) return open("google");
		new ProviderPickerModal(this.app, ["google", "immich"], open).open();
	}

	private parseDate(text: string): moment.Moment | null {
		const formats = [
			this.settings.dateFormat || this.dailyNotesFormat(),
			...this.settings.extraFormats.split(",").map((s) => s.trim()).filter(Boolean),
		];
		for (const fmt of formats) {
			const m = (moment as unknown as (input: string, format: string, strict: boolean) => moment.Moment)(
				text,
				fmt,
				true // strict
			);
			if (m.isValid()) return m;
		}
		return null;
	}

	private dailyNotesFormat(): string {
		// Reads the core Daily Notes (or Periodic Notes) plugin's configured format
		try {
			return getDailyNoteSettings().format || "YYYY-MM-DD";
		} catch {
			return "YYYY-MM-DD";
		}
	}

	// --- Settings plumbing ---

	async loadSettings() {
		const data = (await this.loadData()) as Partial<PhotoSearchSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class PhotoSearchSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PhotoSearchPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default provider")
			.setDesc("'Ask' shows a picker when Immich is configured; otherwise Google Photos.")
			.addDropdown((d) =>
				d
					.addOptions({ ask: "Ask each time", google: "Google Photos", immich: "Immich" })
					.setValue(this.plugin.settings.provider)
					.onChange(async (v) => {
						this.plugin.settings.provider = v as Provider;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Immich base URL")
			.setDesc("e.g. https://immich.yourdomain.net — leave empty to disable Immich.")
			.addText((t) =>
				t
					.setPlaceholder("https://immich.example.com")
					.setValue(this.plugin.settings.immichBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings.immichBaseUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Daily note date format")
			.setDesc("Moment format for parsing note names. Empty = use the Daily Notes core plugin setting.")
			.addText((t) =>
				t
					.setPlaceholder("YYYY-MM-DD")
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (v) => {
						this.plugin.settings.dateFormat = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Extra formats")
			.setDesc("Comma-separated additional Moment formats to try on linked note names.")
			.addText((t) =>
				t
					.setValue(this.plugin.settings.extraFormats)
					.onChange(async (v) => {
						this.plugin.settings.extraFormats = v;
						await this.plugin.saveSettings();
					})
			);
	}
}
