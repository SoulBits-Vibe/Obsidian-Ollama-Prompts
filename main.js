const { Plugin, Notice, FuzzySuggestModal, Modal, Setting, PluginSettingTab, requestUrl } = require("obsidian");

const DEFAULTS = {
  promptsFolder: "system/copilot/copilot-custom-prompts",
  endpoint: "http://127.0.0.1:11434/api/generate",
  model: "qwen3.8:27b-mlx",
};

class PromptPicker extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Run which prompt?");
  }
  getItems() {
    return this.files;
  }
  getItemText(item) {
    return item.basename;
  }
  onChooseItem(item) {
    this.onChoose(item);
  }
}

/* Result box: shows the rewrite, lets her request a change, then replace or close. */
class ResultModal extends Modal {
  constructor(app, plugin, ctx) {
    super(app);
    this.plugin = plugin;
    this.ctx = ctx; // { body, original, conversation: [] , onReplace }
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ollama-prompts-modal");
    contentEl.createEl("h3", { text: this.ctx.title });

    this.input = contentEl.createEl("textarea", { cls: "ollama-prompts-result" });
    this.input.value = this.ctx.current;
    this.input.style.width = "100%";
    this.input.style.height = "300px";
    this.input.style.fontSize = "0.95em";

    const follow = contentEl.createDiv({ cls: "ollama-prompts-follow" });
    this.req = follow.createEl("input", { type: "text", cls: "ollama-prompts-request" });
    this.req.placeholder = "Ask for a change…";
    this.req.style.width = "100%";
    const goBtn = follow.createEl("button", { text: "Send" });
    goBtn.style.marginTop = "6px";

    const send = () => this.refine();
    goBtn.onclick = send;
    this.req.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });

    const row = contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Replace selection", cls: "mod-cta" }).onclick = () => {
      this.ctx.onReplace(this.input.value.trim() || this.ctx.current);
      this.close();
    };
    row.createEl("button", { text: "Close" }).onclick = () => this.close();
  }
  async refine() {
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
  onClose() {
    this.contentEl.empty();
  }
}

class OllamaPromptsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const add = (name, key, desc) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(this.plugin.settings[key]).onChange(async (v) => {
            this.plugin.settings[key] = v.trim();
            await this.plugin.saveData(this.plugin.settings);
          })
        );
    };
    add("Prompt folder", "promptsFolder", "Vault folder holding your prompt markdown files.");
    add("Ollama endpoint", "endpoint", "Local Ollama generate endpoint.");
    add("Model", "model", "Ollama model name.");
  }
}

module.exports = class OllamaPrompts extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data);
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
          const sub = item.setSubmenu();
          files.forEach((f) => {
            sub.addItem((si) =>
              si.setTitle(f.basename).onClick(() => this.runPrompt(editor, f, editor.getSelection()))
            );
          });
        });
      })
    );
  }

  loadPromptFiles() {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.promptsFolder);
    if (!folder) {
      new Notice("Folder not found: " + this.settings.promptsFolder);
      return [];
    }
    if (!folder.children) {
      new Notice("Not a folder: " + this.settings.promptsFolder);
      return [];
    }
    return folder.children
      .filter((f) => f.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  pickPrompt(editor) {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice("Select some text first.");
      return;
    }
    const files = this.loadPromptFiles();
    if (!files.length) return;
    new PromptPicker(this.app, files, (file) => this.runPrompt(editor, file, selection)).open();
  }

  async callModel(ctx, extra) {
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
      const text = (res.json && res.json.response ? res.json.response : "").trim();
      if (!text) {
        new Notice("Model returned nothing.");
        return null;
      }
      return text;
    } catch (err) {
      new Notice("Ollama call failed. Is Ollama running?");
      console.error(err);
      return null;
    }
  }

  async runPrompt(editor, file, selection) {
    const raw = await this.app.vault.read(file);
    const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();

    let original = selection;
    let from = null;
    let to = null;
    try {
      original = editor.getSelection() || selection;
      from = editor.getCursor("from");
      to = editor.getCursor("to");
    } catch (e) {
      /* editor lost focus; keep selection, skip replace */
    }

    const notice = new Notice("Running " + file.basename + " …", 0);
    const ctx = { title: file.basename, body, original, current: "", conversation: [] };
    const first = await this.callModel(ctx, null);
    notice.hide();
    if (first === null) return;

    ctx.current = first;
    this.openResult(editor, ctx, from, to);
  }

  openResult(editor, ctx, from, to) {
    ctx.onReplace = (text) => {
      if (from && to) editor.replaceRange(text, from, to);
    };
    new ResultModal(this.app, this, ctx).open();
  }
};
