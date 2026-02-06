const { Plugin, Modal } = require('obsidian');
const { EditorView, Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');

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
        const regex = /\{\/\{([^\/\n]+)\/([^}\n]+)\}\/\}/g;
        const cursorPos = view.state.selection.main.head;
        const text = view.state.doc.toString();

        let match;
        while ((match = regex.exec(text)) !== null) {
          const start = match.index;
          const end = start + match[0].length;

          if (cursorPos < start || cursorPos > end) {
            const word = match[1].trim();
            let tooltip = match[2].trim().replace(/\}$/, "");
            
            const lines = tooltip.split('\n').map(line => line.trim()).filter(line => line.length > 0);
            tooltip = lines.join(' / ');

            builder.add(start, end, Decoration.replace({
              widget: new TooltipWidget(plugin, word, tooltip),
            }));
          }
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
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

  onload() {
    console.log("Tooltip Plugin loaded");

    this.tooltipElement = null;
    this.pinnedTooltip = null;

    this.registerEditorExtension(tooltipViewPlugin(this));

    this.registerMarkdownPostProcessor((el) => {
      const regex = /\{\/\{([^\/\n]+)\/([^}\n]+)\}\/\}/g;
      el.innerHTML = el.innerHTML.replace(regex, (_, word, tooltip) => {
        tooltip = tooltip.trim().replace(/\}$/, "");
        const uniqueId = `tooltip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
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

module.exports = TooltipPlugin;
