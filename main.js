const { Plugin, Modal } = require('obsidian');

class TooltipPlugin extends Plugin {
  onload() {
    console.log("Tooltip Plugin loaded");

    this.registerMarkdownPostProcessor((el) => {
      const regex = /\{\/\{([^\/]+)\/([^}]+)\}\/\}/g;
      el.innerHTML = el.innerHTML.replace(regex, (_, word, tooltip) => {
        tooltip = tooltip.trim().replace(/\}$/, "");
        return `<span class="tooltip-word">${word}<span class="tooltip-text">${tooltip}</span></span>`;
      });
    });

    this.addCommand({
      id: "insert-tooltip-syntax",
      name: "Wrap selection in {/{ / }/}",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        const word = selection || "word";
        const description = await this.promptForDescription(word);
        const formatted = `{/{${word}/${description}}/}`;
        editor.replaceSelection(formatted);
      },
    });
  }

  async promptForDescription(word) {
    return new Promise((resolve) => {
      const modal = new TooltipPromptModal(this.app, word, resolve);
      modal.open();
    });
  }

  onunload() {
    console.log("Tooltip Plugin unloaded");
  }
}

class TooltipPromptModal extends Modal {
  constructor(app, word, onSubmit) {
    super(app);
    this.word = word;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.style.display = "flex";
    contentEl.style.flexDirection = "column";
    contentEl.style.alignItems = "center";
    contentEl.style.justifyContent = "space-between";
    contentEl.style.height = "260px";
    contentEl.style.padding = "15px";

    const title = contentEl.createEl("h2", {
      text: `Enter description for "${this.word}"`,
    });
    title.style.textAlign = "center";
    title.style.marginBottom = "10px";

    const input = contentEl.createEl("textarea", {
      cls: "tooltip-input",
      attr: { placeholder: "Enter description..." },
    });
    input.style.width = "100%";
    input.style.flexGrow = "1";
    input.style.minHeight = "100px";
    input.style.maxHeight = "180px";
    input.style.resize = "none";
    input.style.padding = "8px";
    input.style.fontSize = "15px";
    input.style.borderRadius = "8px";
    input.style.border = "1px solid var(--background-modifier-border)";
    input.style.backgroundColor = "var(--background-primary)";
    input.style.color = "var(--text-normal)";
    input.style.overflowY = "auto";
    input.style.transition = "all 0.2s ease";

    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = input.scrollHeight + "px";
    });

    const button = contentEl.createEl("button", { text: "Add" });
    button.style.marginTop = "15px";
    button.style.padding = "8px 25px";
    button.style.borderRadius = "8px";
    button.style.border = "none";
    button.style.backgroundColor = "var(--interactive-accent)";
    button.style.color = "white";
    button.style.cursor = "pointer";
    button.style.fontSize = "15px";
    button.style.alignSelf = "center";
    button.style.transition = "opacity 0.2s ease";

    button.onmouseenter = () => (button.style.opacity = "0.8");
    button.onmouseleave = () => (button.style.opacity = "1");

    button.onclick = () => {
      this.onSubmit(input.value.trim() || "description");
      this.close();
    };

    input.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = TooltipPlugin;