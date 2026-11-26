import {
	App,
	Editor,
	EditorPosition,
	FuzzySuggestModal,
	Menu,
	MenuItem,
	Modal,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	TFile,
	TFolder,
} from "obsidian";

// setSubmenu exists at runtime on desktop menus but is not in the current public typings.
type MenuItemWithSubmenu = MenuItem & { setSubmenu: () => Menu };

interface OllamaPromptsSettings {
	promptsFolder: string;
	endpoint: string;
	model: string;
}

const DEFAULT_SETTINGS: OllamaPromptsSettings = {
	promptsFolder: "system/prompts",
	endpoint: "http://127.0.0.1:11434/api/generate",
	model: "",
};

interface ConversationTurn {
	request: string;
	result: string;
}

interface ResultContext {
	title: string;
	body: string;
	original: string;
	current: string;
	conversation: ConversationTurn[];
	onReplace: (text: string) => void;
}

interface RequestErrorShape {
	status?: number;
	message?: string;
	text?: string;
	json?: { error?: string };
}

class PromptPicker extends FuzzySuggestModal<TFile> {
	files: TFile[];
	onChoose: (file: TFile) => void;

	constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onChoose = onChoose;
		this.setPlaceholder("Run which prompt?");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.basename;
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

/* Result box: shows the rewrite, lets you request a change, then replace or close. */
class ResultModal extends Modal {
	plugin: OllamaPrompts;
	ctx: ResultContext;
	input!: HTMLTextAreaElement;
	req!: HTMLInputElement;

	constructor(app: App, plugin: OllamaPrompts, ctx: ResultContext) {
		super(app);
		this.plugin = plugin;
		this.ctx = ctx;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("ollama-prompts-modal");
		contentEl.createEl("h3", { text: this.ctx.title });

		this.input = contentEl.createEl("textarea", { cls: "ollama-prompts-result" });
		this.input.value = this.ctx.current;

		const follow = contentEl.createDiv({ cls: "ollama-prompts-follow" });
		this.req = follow.createEl("input", { type: "text", cls: "ollama-prompts-request" });
		this.req.placeholder = "Ask for a change…";
		const goBtn = follow.createEl("button", { text: "Send" });

		const send = () => void this.refine();
		goBtn.addEventListener("click", send);
		this.req.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				send();
			}
		});

		const row = contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: "Replace selection", cls: "mod-cta" }).addEventListener(
			"click",
			() => {
				this.ctx.onReplace(this.input.value.trim() || this.ctx.current);
				this.close();
			},
		);
		row.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	async refine(): Promise<void> {
		const ask = this.req.value.trim();
		if (!ask) return;
		this.req.value = "";
		this.input.value = "…";
		const next = await this.plugin.callModel(this.ctx, ask);
		if (next === null) {
			this.input.value = this.ctx.current;
			return;
		}
		this.ctx.current = next;
		this.ctx.conversation.push({ request: ask, result: next });
		this.input.value = next;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class OllamaPromptsSettingTab extends PluginSettingTab {
	plugin: OllamaPrompts;

	constructor(app: App, plugin: OllamaPrompts) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// 1.13.0+: Obsidian calls this and skips display(), so settings appear in search.
	// Controls bind to this.plugin.settings[key] and are saved automatically.
	getSettingDefinitions() {
		return [
			{
				name: "Prompt folder",
				desc: "Vault folder holding your prompt markdown files.",
				control: { type: "text" as const, key: "promptsFolder" },
			},
			{
				name: "Ollama endpoint",
				desc: "Local Ollama generate endpoint.",
				control: { type: "text" as const, key: "endpoint" },
			},
			{
				name: "Model",
				desc: "Exact name from `ollama list`. Leave this empty until you set a model you have installed.",
				control: { type: "text" as const, key: "model" },
			},
		];
	}

	// < 1.13.0: Obsidian calls this. Keep the original imperative settings tab.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const add = (name: string, key: keyof OllamaPromptsSettings, desc: string) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(this.plugin.settings[key]).onChange(async (v) => {
						this.plugin.settings[key] = v.trim();
						await this.plugin.saveData(this.plugin.settings);
					}),
				);
		};

		add("Prompt folder", "promptsFolder", "Vault folder holding your prompt markdown files.");
		add("Ollama endpoint", "endpoint", "Local Ollama generate endpoint.");
		add(
			"Model",
			"model",
			"Exact name from `ollama list`. Leave this empty until you set a model you have installed.",
		);
	}
}

export default class OllamaPrompts extends Plugin {
	settings!: OllamaPromptsSettings;

	async onload(): Promise<void> {
		const data = (await this.loadData()) as Partial<OllamaPromptsSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.addSettingTab(new OllamaPromptsSettingTab(this.app, this));

		this.addCommand({
			id: "run-prompt-on-selection",
			name: "Run a prompt file on the selection",
			editorCallback: (editor) => this.pickPrompt(editor),
		});

		// Right-click menu, with the prompts listed directly in a submenu.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!editor.getSelection()) return;
				const files = this.loadPromptFiles();
				if (!files.length) return;

				menu.addItem((item) => {
					item.setTitle("Ollama prompt").setIcon("sparkles");
					const withSub = item as MenuItemWithSubmenu;
					if (typeof withSub.setSubmenu === "function") {
						const sub = withSub.setSubmenu();
						files.forEach((f) => {
							sub.addItem((si) =>
								si.setTitle(f.basename).onClick(() => {
									void this.runPrompt(editor, f, editor.getSelection());
								}),
							);
						});
					} else {
						item.onClick(() => this.pickPrompt(editor));
					}
				});
			}),
		);
	}

	loadPromptFiles(): TFile[] {
		const folderPath = normalizePath(this.settings.promptsFolder);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			new Notice("Folder not found: " + folderPath);
			return [];
		}
		if (!(folder instanceof TFolder)) {
			new Notice("Not a folder: " + folderPath);
			return [];
		}
		return folder.children
			.filter((f): f is TFile => f instanceof TFile && f.extension === "md")
			.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	pickPrompt(editor: Editor): void {
		const selection = editor.getSelection();
		if (!selection) {
			new Notice("Select some text first.");
			return;
		}
		const files = this.loadPromptFiles();
		if (!files.length) return;
		new PromptPicker(this.app, files, (file) => {
			void this.runPrompt(editor, file, selection);
		}).open();
	}

	formatOllamaError(err: unknown): string {
		const e = err as RequestErrorShape;
		let detail = "";
		if (e?.json && typeof e.json.error === "string") {
			detail = e.json.error;
		} else if (typeof e?.text === "string" && e.text.trim()) {
			try {
				const parsed = JSON.parse(e.text) as { error?: string };
				detail = parsed.error || e.text.trim();
			} catch {
				detail = e.text.trim();
			}
		}

		const message = typeof e?.message === "string" ? e.message : err instanceof Error ? err.message : String(err);
		const combined = `${detail} ${message}`.toLowerCase();

		if (
			/model ['"]?[^'"]+['"]? (not found|does not exist|not found, try pulling)/i.test(detail) ||
			/not found|does not exist|try pulling/i.test(combined)
		) {
			const model = this.settings.model || "(none set)";
			return detail
				? `Model not found: ${model}. ${detail}`
				: `Model not found: ${model}. Check the name in the plugin settings, or run ollama list.`;
		}

		if (
			e?.status === 0 ||
			/failed to fetch|econnrefused|err_connection|networkerror|load failed|network request failed/i.test(
				combined,
			)
		) {
			return "Could not reach Ollama. Is it running?";
		}

		if (detail) {
			return e?.status ? `Ollama error (HTTP ${e.status}): ${detail}` : `Ollama error: ${detail}`;
		}
		if (e?.status) {
			return `Ollama request failed (HTTP ${e.status}). ${message}`.trim();
		}
		return message || "Ollama call failed.";
	}

	async callModel(ctx: ResultContext, extra: string | null): Promise<string | null> {
		if (!this.settings.model) {
			new Notice("No model name is set. Add one in the plugin settings; use a name from `ollama list`.");
			return null;
		}
		if (!this.settings.endpoint) {
			new Notice("No endpoint is set. Add one in the plugin settings.");
			return null;
		}

		const parts = [ctx.body, "\n---\nTEXT:\n" + ctx.original];
		parts.push("\n\nCURRENT RESULT:\n" + ctx.current);
		if (extra) parts.push("\n\nCHANGE REQUESTED:\n" + extra);
		else parts.push("\n\nReturn only the rewritten text. No preamble, no quotes, no code fences.");

		try {
			const res = await requestUrl({
				url: this.settings.endpoint,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({
					model: this.settings.model,
					prompt: parts.join(""),
					stream: false,
					think: false,
					options: { temperature: 0.4 },
				}),
			});

			const payload = res.json as { response?: string; error?: string } | undefined;
			if (payload && typeof payload.error === "string" && payload.error) {
				new Notice(this.formatOllamaError({ status: res.status, json: payload, message: payload.error }));
				return null;
			}

			const text = (payload && payload.response ? payload.response : "").trim();
			if (!text) {
				new Notice("Model returned nothing.");
				return null;
			}
			return text;
		} catch (err) {
			new Notice(this.formatOllamaError(err));
			return null;
		}
	}

	async runPrompt(editor: Editor, file: TFile, selection: string): Promise<void> {
		const raw = await this.app.vault.read(file);
		const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();

		let original = selection;
		let from: EditorPosition | null = null;
		let to: EditorPosition | null = null;
		try {
			original = editor.getSelection() || selection;
			from = editor.getCursor("from");
			to = editor.getCursor("to");
		} catch {
			/* editor lost focus; keep selection, skip replace */
		}

		const notice = new Notice("Running " + file.basename + " …", 0);
		const ctx: ResultContext = {
			title: file.basename,
			body,
			original,
			current: "",
			conversation: [],
			onReplace: () => {},
		};
		const first = await this.callModel(ctx, null);
		notice.hide();
		if (first === null) return;

		ctx.current = first;
		this.openResult(editor, ctx, from, to);
	}

	openResult(
		editor: Editor,
		ctx: ResultContext,
		from: EditorPosition | null,
		to: EditorPosition | null,
	): void {
		ctx.onReplace = (text) => {
			if (from && to) editor.replaceRange(text, from, to);
		};
		new ResultModal(this.app, this, ctx).open();
	}
}
