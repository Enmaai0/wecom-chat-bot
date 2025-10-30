// 提取 mermaid 代码块（支持 ```mermaid```、<mermaid>...</mermaid>、HTML code 标签）

function extractMermaidBlocksFromText(text = '') {
  const blocks = [];
  if (!text) return blocks;
  // ```mermaid\n ... \n```
  const fenceRe = /```\s*mermaid\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const code = (m[1] || '').trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

function extractMermaidBlocksFromHtml(html = '') {
  const blocks = [];
  if (!html) return blocks;
  // <mermaid> ... </mermaid>
  const tagRe = /<\s*mermaid\s*>([\s\S]*?)<\s*\/\s*mermaid\s*>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const code = (m[1] || '').trim();
    if (code) blocks.push(decodeHtmlEntities(code));
  }
  // <pre><code class="language-mermaid"> ... </code></pre>
  const codeRe = /<\s*code[^>]*class\s*=\s*"[^"]*mermaid[^"]*"[^>]*>([\s\S]*?)<\s*\/\s*code\s*>/gi;
  while ((m = codeRe.exec(html)) !== null) {
    const code = (m[1] || '').replace(/<[^>]*>/g, '').trim();
    if (code) blocks.push(decodeHtmlEntities(code));
  }
  return blocks;
}

function decodeHtmlEntities(str = '') {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function extractMermaidBlocks(text = '', rawHtml = '') {
  const fromText = extractMermaidBlocksFromText(text);
  const fromHtml = extractMermaidBlocksFromHtml(rawHtml);
  // 合并去重
  const set = new Set([...(fromText || []), ...(fromHtml || [])]);
  return Array.from(set);
}

module.exports = {
  extractMermaidBlocks,
  extractMermaidBlocksFromText,
  extractMermaidBlocksFromHtml,
};