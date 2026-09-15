/** BOSS chat places its scrollbar on resume-detail-chat, unlike recommendation previews.
 * Keep native vertical scrolling, but give the fixed canvas its full content width.
 * The returned closure restores every original inline declaration after capture.
 */
export function prepareChatResumeLayout(iframe: Element): () => void {
  const declarations: Array<{node: HTMLElement; value: string; priority: string}> = [];
  for (let node = iframe.parentElement; node; node = node.parentElement) {
    if (node.matches('.resume-detail-chat, .resume-detail-wrap')) {
      declarations.push({node,value:node.style.getPropertyValue('scrollbar-width'),priority:node.style.getPropertyPriority('scrollbar-width')});
      node.style.setProperty('scrollbar-width','none','important');
    }
    if (node.matches('.boss-popup__wrapper')) break;
  }
  return () => {
    for (const {node,value,priority} of declarations) {
      if (value) node.style.setProperty('scrollbar-width',value,priority);
      else node.style.removeProperty('scrollbar-width');
    }
  };
}
