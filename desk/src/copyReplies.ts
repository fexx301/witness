// A small copy button at the end of each agent reply in AG Studio's chat, which has no message actions of its
// own. It copies the reply as plain text: paragraphs, and list items as "- " lines.

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export function replyText(message: Element): string {
  const blocks = [...message.querySelectorAll(".ag-studio-rich-text")].flatMap((rich) => [...rich.children] as HTMLElement[]);
  if (!blocks.length) return (message.querySelector<HTMLElement>(".ag-studio-ai-output-message-content")?.innerText ?? "").trim();
  return blocks
    .map((block) =>
      block.tagName === "UL" || block.tagName === "OL"
        ? ([...block.children] as HTMLElement[]).map((item, i) => `${block.tagName === "OL" ? `${i + 1}.` : "-"} ${item.innerText.trim()}`).join("\n")
        : block.innerText.trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

function addButton(message: HTMLElement) {
  if (message.querySelector(":scope > .witness-copy") || !message.querySelector(".ag-studio-ai-output-message-content")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "witness-copy";
  button.title = "Copy reply";
  button.setAttribute("aria-label", "Copy reply");
  button.innerHTML = COPY_ICON;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(replyText(message));
      button.textContent = "Copied";
    } catch {
      button.textContent = "Couldn't copy";
    }
    setTimeout(() => (button.innerHTML = COPY_ICON), 1500);
  });
  message.append(button);
}

// Watches the chat, since Studio renders replies (and re-renders them while they stream) on its own.
export function addCopyButtons(root: HTMLElement): () => void {
  const scan = () => root.querySelectorAll<HTMLElement>(".ag-studio-ai-output-message").forEach(addButton);
  const observer = new MutationObserver(scan);
  observer.observe(root, { childList: true, subtree: true });
  scan();
  return () => observer.disconnect();
}
