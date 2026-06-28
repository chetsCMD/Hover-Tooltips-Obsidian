const { Plugin, Modal, PluginSettingTab, Setting, Notice, TFolder, TFile } = require('obsidian');
const { EditorView, Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');

const SYNTAX_REGEX = /\{\/\{([^\/\n]+)\/([^}\n]+)\}\/\}/g;

const DEFAULT_SETTINGS = {
  dictionaries: [],
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function pathMatchesScope(dictionary, filePath) {
  if (!filePath) return false;
  if (!dictionary.path) return false;

  if (dictionary.type === 'note') {
    const normalized = dictionary.path.endsWith('.md') ? dictionary.path : `${dictionary.path}.md`;
    return filePath === dictionary.path || filePath === normalized;
  }

  if (dictionary.type === 'folder') {
    const folder = dictionary.path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (folder === '' || folder === '/') return true;
    return filePath === folder || filePath.startsWith(folder + '/');
  }

  return false;
}

function getAllFolderPaths(app) {
  const folders = [];

  const recurse = (folder) => {
    if (folder.path && folder.path !== '/') folders.push(folder.path);
    folder.children.forEach(child => {
      if (child instanceof TFolder) recurse(child);
    });
  };

  recurse(app.vault.getRoot());
  folders.unshift('/');
  return folders;
}

class PathSuggest {
  constructor(inputEl, items, onSelect) {
    this.inputEl = inputEl;
    this.items = items;
    this.onSelect = onSelect;
    this.containerEl = null;

    this.handleInput = () => this.render(this.getMatches());
    this.handleFocus = () => this.render(this.getMatches());
    this.handleBlur = () => {
      window.setTimeout(() => this.close(), 150);
    };
    this.handleKeyDown = (e) => {
      if (e.key === 'Escape') this.close();
    };

    this.inputEl.addEventListener('input', this.handleInput);
    this.inputEl.addEventListener('focus', this.handleFocus);
    this.inputEl.addEventListener('blur', this.handleBlur);
    this.inputEl.addEventListener('keydown', this.handleKeyDown);
  }

  getMatches() {
    const query = this.inputEl.value.toLowerCase();
    return this.items.filter(item => item.toLowerCase().includes(query)).slice(0, 50);
  }

  render(matches) {
    this.close();
    if (matches.length === 0) return;

    const rect = this.inputEl.getBoundingClientRect();
    const container = document.createElement('div');
    container.className = 'tooltip-path-suggest';
    container.style.position = 'fixed';
    container.style.zIndex = '2147483647';
    container.style.left = `${rect.left}px`;
    container.style.top = `${rect.bottom + 2}px`;
    container.style.width = `${rect.width}px`;
    container.style.maxHeight = '220px';
    container.style.overflowY = 'auto';
    container.style.backgroundColor = 'var(--background-primary)';
    container.style.border = '1px solid var(--background-modifier-border)';
    container.style.borderRadius = '6px';
    container.style.boxShadow = '0 6px 18px rgba(0, 0, 0, 0.25)';

    matches.forEach(item => {
      const itemEl = document.createElement('div');
      itemEl.textContent = item;
      itemEl.style.padding = '6px 10px';
      itemEl.style.cursor = 'pointer';
      itemEl.style.fontSize = '0.9em';

      itemEl.addEventListener('mouseenter', () => {
        itemEl.style.backgroundColor = 'var(--background-modifier-hover)';
      });
      itemEl.addEventListener('mouseleave', () => {
        itemEl.style.backgroundColor = '';
      });

      itemEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.inputEl.value = item;
        this.inputEl.dispatchEvent(new Event('input'));
        if (this.onSelect) this.onSelect(item);
        this.close();
      });

      container.appendChild(itemEl);
    });

    document.body.appendChild(container);
    this.containerEl = container;
  }

  close() {
    if (this.containerEl) {
      this.containerEl.remove();
      this.containerEl = null;
    }
  }

  destroy() {
    this.close();
    this.inputEl.removeEventListener('input', this.handleInput);
    this.inputEl.removeEventListener('focus', this.handleFocus);
    this.inputEl.removeEventListener('blur', this.handleBlur);
    this.inputEl.removeEventListener('keydown', this.handleKeyDown);
  }
}

class TooltipWidget extends WidgetType {
  constructor(plugin, word, tooltip) {
    super();
    this.plugin = plugin;
    this.word = word;
    this.tooltip = tooltip;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'tooltip-word';
    span.textContent = this.word;
    span.setAttribute('data-tooltip', this.tooltip);

    span.addEventListener('mouseenter', (e) => {
      this.plugin.showTooltip(span, this.tooltip);
    });

    span.addEventListener('mouseleave', (e) => {
      this.plugin.hideTooltip();
    });

    return span;
  }

  eq(other) {
    return other.word === this.word && other.tooltip === this.tooltip;
  }

  ignoreEvent() {
    return false;
  }
}

const tooltipViewPlugin = (plugin) => {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = this.buildDecorations(view, plugin);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view, plugin);
        }
      }

      buildDecorations(view, plugin) {
        const builder = new RangeSetBuilder();
        const cursorPos = view.state.selection.main.head;
        const text = view.state.doc.toString();

        const ranges = [];

        let match;
        SYNTAX_REGEX.lastIndex = 0;
        while ((match = SYNTAX_REGEX.exec(text)) !== null) {
          const start = match.index;
          const end = start + match[0].length;

          if (cursorPos < start || cursorPos > end) {
            const word = match[1].trim();
            let tooltip = match[2].trim().replace(/\}$/, "");

            const lines = tooltip.split('\n').map(line => line.trim()).filter(line => line.length > 0);
            tooltip = lines.join(' / ');

            ranges.push({
              start,
              end,
              deco: Decoration.replace({ widget: new TooltipWidget(plugin, word, tooltip) }),
            });
          }
        }

        const filePath = plugin.getCurrentFilePath(view);
        const dictMap = plugin.getDictionaryWordsForPath(filePath);

        if (dictMap.size > 0) {
          const dictRegex = plugin.buildDictionaryRegex(dictMap);
          if (dictRegex) {
            dictRegex.lastIndex = 0;
            let dMatch;
            while ((dMatch = dictRegex.exec(text)) !== null) {
              const start = dMatch.index;
              const end = start + dMatch[0].length;

              const overlaps = ranges.some(r => start < r.end && end > r.start);
              if (overlaps) continue;
              if (cursorPos >= start && cursorPos <= end) continue;

              const matchedWord = dMatch[0];
              const tooltip = dictMap.get(matchedWord.toLowerCase());
              if (!tooltip) continue;

              ranges.push({
                start,
                end,
                deco: Decoration.mark({
                  class: 'tooltip-word tooltip-dict-word',
                  attributes: { 'data-tooltip': tooltip },
                }),
              });
            }
          }
        }

        ranges.sort((a, b) => a.start - b.start);
        ranges.forEach(r => builder.add(r.start, r.end, r.deco));

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mouseover(e, view) {
          const target = e.target;
          if (target && target.classList && target.classList.contains('tooltip-dict-word')) {
            const tooltip = target.getAttribute('data-tooltip');
            if (tooltip) plugin.showTooltip(target, tooltip);
          }
        },
        mouseout(e, view) {
          const target = e.target;
          if (target && target.classList && target.classList.contains('tooltip-dict-word')) {
            plugin.hideTooltip();
          }
        },
      },
    }
  );
};

class TooltipPlugin extends Plugin {
  sanitizeHtml(html) {
    const allowedTags = ['code', 'strong', 'em', 'mark', 'a', 'br'];
    const allowedAttributes = {
      'a': ['href', 'class', 'target', 'rel']
    };

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const sanitizeNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.cloneNode();
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();

        if (!allowedTags.includes(tagName)) {
          const fragment = document.createDocumentFragment();
          Array.from(node.childNodes).forEach(child => {
            const sanitizedChild = sanitizeNode(child);
            if (sanitizedChild) {
              fragment.appendChild(sanitizedChild);
            }
          });
          return fragment;
        }

        const newElement = document.createElement(tagName);

        if (allowedAttributes[tagName]) {
          allowedAttributes[tagName].forEach(attr => {
            if (node.hasAttribute(attr)) {
              newElement.setAttribute(attr, node.getAttribute(attr));
            }
          });
        }

        Array.from(node.childNodes).forEach(child => {
          const sanitizedChild = sanitizeNode(child);
          if (sanitizedChild) {
            newElement.appendChild(sanitizedChild);
          }
        });

        return newElement;
      }

      return null;
    };

    const sanitizedDiv = document.createElement('div');
    Array.from(doc.body.childNodes).forEach(child => {
      const sanitizedChild = sanitizeNode(child);
      if (sanitizedChild) {
        sanitizedDiv.appendChild(sanitizedChild);
      }
    });

    return sanitizedDiv.innerHTML;
  }

  processMarkdownLine(line) {
    line = this.escapeHtml(line);

    line = line.replace(/`([^`]+)`/g, '<code>$1</code>');
    line = line.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
    line = line.replace(/==([^=]+)==/g, '<mark>$1</mark>');

    line = line.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (match, text, url) => {
      return `<a href="${url}" class="external-link" target="_blank" rel="noopener">${text}</a>`;
    });

    line = line.replace(/\[\[([^\]]+)\]\]/g, (match, link) => {
      const parts = link.split('|');
      const href = parts[0];
      const text = parts[1] || href;
      return `<a href="${href}" class="internal-link">${text}</a>`;
    });

    return line;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!Array.isArray(this.settings.dictionaries)) {
      this.settings.dictionaries = [];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getCurrentFilePath(view) {
    const activeFile = this.app.workspace.getActiveFile();
    return activeFile ? activeFile.path : null;
  }

  getDictionaryWordsForPath(filePath) {
    const map = new Map();
    if (!filePath || !this.settings) return map;

    for (const dictionary of this.settings.dictionaries) {
      if (!pathMatchesScope(dictionary, filePath)) continue;
      for (const entry of dictionary.words || []) {
        if (!entry.word) continue;
        map.set(entry.word.trim().toLowerCase(), entry.tooltip);
      }
    }

    return map;
  }

  buildDictionaryRegex(dictMap) {
    const words = Array.from(dictMap.keys()).filter(w => w.length > 0);
    if (words.length === 0) return null;

    words.sort((a, b) => b.length - a.length);
    const pattern = words.map(escapeRegex).join('|');
    return new RegExp(`(?<![\\p{L}\\p{N}_])(${pattern})(?![\\p{L}\\p{N}_])`, 'giu');
  }

  decorateDictionaryWordsInElement(el, filePath) {
    const dictMap = this.getDictionaryWordsForPath(filePath);
    if (dictMap.size === 0) return;

    const regex = this.buildDictionaryRegex(dictMap);
    if (!regex) return;

    const skipTags = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE']);

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        let parent = node.parentElement;
        while (parent && parent !== el) {
          if (skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.classList && parent.classList.contains('tooltip-word')) return NodeFilter.FILTER_REJECT;
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    let current;
    while ((current = walker.nextNode())) {
      textNodes.push(current);
    }

    textNodes.forEach(textNode => {
      const text = textNode.nodeValue;
      regex.lastIndex = 0;
      if (!regex.test(text)) return;
      regex.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;

        if (start > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        }

        const matchedWord = match[0];
        const tooltip = dictMap.get(matchedWord.toLowerCase());

        const span = document.createElement('span');
        span.className = 'tooltip-word tooltip-dict-word';
        span.textContent = matchedWord;
        span.setAttribute('data-tooltip', tooltip || '');

        fragment.appendChild(span);
        lastIndex = end;
      }

      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      textNode.parentNode.replaceChild(fragment, textNode);
    });

    el.querySelectorAll('.tooltip-dict-word').forEach(wordElement => {
      wordElement.addEventListener('mouseenter', (e) => {
        if (this.pinnedTooltip) return;
        this.showTooltip(e.target, e.target.getAttribute('data-tooltip'));
      });

      wordElement.addEventListener('mouseleave', (e) => {
        if (this.pinnedTooltip) return;
        this.hideTooltip();
      });

      wordElement.addEventListener('click', (e) => {
        e.stopPropagation();
        const tooltipContent = e.target.getAttribute('data-tooltip');

        if (this.pinnedTooltip === e.target) {
          this.pinnedTooltip = null;
          this.hideTooltip();
        } else {
          this.pinnedTooltip = e.target;
          this.showTooltip(e.target, tooltipContent);
        }
      });
    });
  }

  async onload() {
    console.log("Tooltip Plugin loaded");

    this.tooltipElement = null;
    this.pinnedTooltip = null;

    await this.loadSettings();
    this.addSettingTab(new TooltipSettingTab(this.app, this));

    this.registerEditorExtension(tooltipViewPlugin(this));

    this.registerMarkdownPostProcessor((el, ctx) => {
      el.innerHTML = el.innerHTML.replace(SYNTAX_REGEX, (_, word, tooltip) => {
        tooltip = tooltip.trim().replace(/\}$/, "");

        const lines = tooltip.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        const formattedTooltip = lines.join(' / ');

        const escapedWord = this.escapeHtml(word.trim());

        return `
          <span class="tooltip-word" data-tooltip="${formattedTooltip.replace(/"/g, '&quot;')}" onclick="event.stopPropagation();">
            ${escapedWord}
          </span>
        `;
      });

      el.querySelectorAll('.tooltip-word').forEach(wordElement => {
        wordElement.addEventListener('mouseenter', (e) => {
          if (this.pinnedTooltip) return;
          this.showTooltip(e.target, e.target.getAttribute('data-tooltip'));
        });

        wordElement.addEventListener('mouseleave', (e) => {
          if (this.pinnedTooltip) return;
          this.hideTooltip();
        });

        wordElement.addEventListener('click', (e) => {
          e.stopPropagation();
          const tooltipContent = e.target.getAttribute('data-tooltip');

          if (this.pinnedTooltip === e.target) {
            this.pinnedTooltip = null;
            this.hideTooltip();
          } else {
            this.pinnedTooltip = e.target;
            this.showTooltip(e.target, tooltipContent);
          }
        });
      });

      this.decorateDictionaryWordsInElement(el, ctx.sourcePath);
    });

    this.registerDomEvent(document, 'click', (e) => {
      if (this.pinnedTooltip && !this.pinnedTooltip.contains(e.target) &&
          (!this.tooltipElement || !this.tooltipElement.contains(e.target))) {
        this.pinnedTooltip = null;
        this.hideTooltip();
      }
    });

    this.addCommand({
      id: "insert-tooltip-syntax",
      name: "Wrap selection in {/{ / }/}",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        const word = selection || "word";
        const description = await this.promptForDescription(word);

        const lines = description.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);

        const formattedDescription = lines.join(' / ');
        const formatted = `{/{${word}/${formattedDescription}}/}`;
        editor.replaceSelection(formatted);
      },
    });
  }

  showTooltip(element, content) {
    if (!this.tooltipElement) {
      this.tooltipElement = document.createElement('div');
      this.tooltipElement.className = 'tooltip-text';
      this.tooltipElement.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      document.body.appendChild(this.tooltipElement);
    }

    const lines = content.split(' / ').map(line => line.trim());

    const processedLines = lines.map(line => {
      if (line.match(/<[^>]+>/)) {
        return line;
      } else {
        return this.processMarkdownLine(line);
      }
    });

    const tooltipHTML = processedLines.join('<br>');
    const sanitizedHTML = this.sanitizeHtml(tooltipHTML);

    this.tooltipElement.innerHTML = sanitizedHTML;

    const rect = element.getBoundingClientRect();
    const tooltipRect = this.tooltipElement.getBoundingClientRect();

    let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
    let top = rect.top - tooltipRect.height - 5;

    if (left < 5) left = 5;
    if (left + tooltipRect.width > window.innerWidth - 5) {
      left = window.innerWidth - tooltipRect.width - 5;
    }

    if (top < 5) {
      top = rect.bottom + 5;
    }

    this.tooltipElement.style.left = left + 'px';
    this.tooltipElement.style.top = top + 'px';
    this.tooltipElement.classList.add('visible');

    const internalLinks = this.tooltipElement.querySelectorAll('a.internal-link');
    const app = this.app;
    internalLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const linkText = link.getAttribute('href');
        app.workspace.openLinkText(linkText, '', false);
      });
    });

    const externalLinks = this.tooltipElement.querySelectorAll('a.external-link');
    externalLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });
  }

  hideTooltip() {
    if (this.tooltipElement) {
      this.tooltipElement.classList.remove('visible');
    }
  }

  async promptForDescription(word) {
    return new Promise((resolve) => {
      const modal = new TooltipPromptModal(this.app, word, resolve);
      modal.open();
    });
  }

  onunload() {
    console.log("Tooltip Plugin unloaded");
    if (this.tooltipElement) {
      this.tooltipElement.remove();
    }
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

class DictionaryWordModal extends Modal {
  constructor(app, existingEntry, onSubmit) {
    super(app);
    this.existingEntry = existingEntry || { word: '', tooltip: '' };
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.existingEntry.word ? "Edit word" : "Add word" });

    let wordValue = this.existingEntry.word;
    let tooltipValue = (this.existingEntry.tooltip || '').split(' / ').join('\n');

    new Setting(contentEl)
      .setName("Word or phrase")
      .addText(text => {
        text.setValue(wordValue);
        text.onChange(v => wordValue = v);
        text.inputEl.style.width = "100%";
      });

    new Setting(contentEl)
      .setName("Tooltip")
      .addTextArea(textarea => {
        textarea.setValue(tooltipValue);
        textarea.onChange(v => tooltipValue = v);
        textarea.inputEl.style.width = "100%";
        textarea.inputEl.style.minHeight = "100px";
      });

    new Setting(contentEl)
      .addButton(btn => {
        btn.setButtonText("Save");
        btn.setCta();
        btn.onClick(() => {
          if (!wordValue.trim()) {
            new Notice("Enter a word or phrase");
            return;
          }

          const lines = tooltipValue.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
          const formattedTooltip = lines.join(' / ');

          this.onSubmit({ word: wordValue.trim(), tooltip: formattedTooltip });
          this.close();
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TooltipSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.display = this.display.bind(this);
    this.containerEl.empty();

    const { containerEl } = this;
    containerEl.createEl("h2", { text: "Persistent Dictionaries" });
    containerEl.createEl("p", {
      text: "Dictionaries let you automatically apply tooltips to words in a specific note or across an entire folder of notes, without manually inserting {/{ }/} syntax.",
    });

    new Setting(containerEl)
      .setName("Add a new dictionary")
      .addButton(btn => {
        btn.setButtonText("+ Dictionary");
        btn.setCta();
        btn.onClick(async () => {
          this.plugin.settings.dictionaries.push({
            id: generateId(),
            path: '',
            type: 'folder',
            words: [],
          });
          await this.plugin.saveSettings();
          this.display();
        });
      });

    this.plugin.settings.dictionaries.forEach((dictionary) => {
      this.renderDictionary(containerEl, dictionary);
    });
  }

  renderDictionary(containerEl, dictionary) {
    const box = containerEl.createDiv({ cls: "tooltip-dict-box" });
    box.style.border = "1px solid var(--background-modifier-border)";
    box.style.borderRadius = "8px";
    box.style.padding = "12px";
    box.style.marginTop = "16px";

    new Setting(box)
      .setName("Scope")
      .addDropdown(dropdown => {
        dropdown.addOption('folder', 'Folder');
        dropdown.addOption('note', 'Specific note');
        dropdown.setValue(dictionary.type);
        dropdown.onChange(async (value) => {
          dictionary.type = value;
          await this.plugin.saveSettings();
          this.display();
        });
      })
      .addText(text => {
        text.setPlaceholder(dictionary.type === 'note' ? 'Folder/Note.md' : 'Folder/Subfolder');
        text.setValue(dictionary.path);
        text.onChange(async (value) => {
          dictionary.path = value.trim();
          await this.plugin.saveSettings();
        });
        text.inputEl.style.width = "100%";

        const items = dictionary.type === 'note'
          ? this.plugin.app.vault.getMarkdownFiles().map(f => f.path)
          : getAllFolderPaths(this.plugin.app);
        new PathSuggest(text.inputEl, items, async (value) => {
          dictionary.path = value;
          await this.plugin.saveSettings();
        });
      })
      .addExtraButton(btn => {
        btn.setIcon("trash");
        btn.setTooltip("Delete dictionary");
        btn.onClick(async () => {
          this.plugin.settings.dictionaries = this.plugin.settings.dictionaries.filter(d => d.id !== dictionary.id);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const wordsContainer = box.createDiv({ cls: "tooltip-dict-words" });
    wordsContainer.style.marginTop = "8px";

    (dictionary.words || []).forEach((entry, index) => {
      const row = wordsContainer.createDiv();
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.padding = "6px 0";
      row.style.borderTop = "1px solid var(--background-modifier-border)";

      const label = row.createDiv();
      label.style.flexGrow = "1";
      label.createEl("strong", { text: entry.word });
      label.createEl("div", { text: entry.tooltip, cls: "tooltip-dict-preview" });
      label.querySelector(".tooltip-dict-preview").style.color = "var(--text-muted)";
      label.querySelector(".tooltip-dict-preview").style.fontSize = "0.9em";

      const actions = row.createDiv();
      const editBtn = actions.createEl("button", { text: "✎" });
      editBtn.style.marginRight = "6px";
      editBtn.onclick = () => {
        const modal = new DictionaryWordModal(this.app, entry, async (updated) => {
          dictionary.words[index] = updated;
          await this.plugin.saveSettings();
          this.display();
        });
        modal.open();
      };

      const deleteBtn = actions.createEl("button", { text: "✕" });
      deleteBtn.onclick = async () => {
        dictionary.words.splice(index, 1);
        await this.plugin.saveSettings();
        this.display();
      };
    });

    const addWordSetting = new Setting(box)
      .addButton(btn => {
        btn.setButtonText("+ Word");
        btn.onClick(() => {
          const modal = new DictionaryWordModal(this.app, null, async (entry) => {
            if (!dictionary.words) dictionary.words = [];
            dictionary.words.push(entry);
            await this.plugin.saveSettings();
            this.display();
          });
          modal.open();
        });
      });
    addWordSetting.settingEl.style.borderTop = "none";
    addWordSetting.settingEl.style.marginTop = "8px";
  }
}

module.exports = TooltipPlugin;
