const puppeteer = require('puppeteer');

const MERMAID_CDN = 'https://unpkg.com/mermaid@10/dist/mermaid.min.js';

// 缓存浏览器实例以提高性能
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    console.log('Launching new Puppeteer browser instance...');
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserInstance;
}

async function renderMermaid(code) {
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Mermaid</title>
        <script src="${MERMAID_CDN}"></script>
        <script>
          mermaid.initialize({ startOnLoad: false });
          window.render = async (code) => {
            try {
              const { svg } = await mermaid.render('mermaid-svg', code);
              document.body.innerHTML = svg;
              const svgEl = document.querySelector('svg');
              return {
                width: svgEl.viewBox.baseVal.width,
                height: svgEl.viewBox.baseVal.height,
              };
            } catch (e) {
              return { error: e.message };
            }
          };
        </script>
      </head>
      <body></body>
      </html>
    `;

    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    console.log('Rendering Mermaid code...\n' + code.substring(0, 100) + '...');
    const dimensions = await page.evaluate((code) => window.render(code), code);

    if (dimensions.error) {
      throw new Error(`Mermaid render error: ${dimensions.error}`);
    }

    await page.setViewport({
      width: Math.ceil(dimensions.width) + 30,
      height: Math.ceil(dimensions.height) + 30,
    });

    const pngBuffer = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: true,
    });
    
    console.log('Mermaid rendered to PNG buffer, size:', pngBuffer.length, 'bytes');
    return pngBuffer;

  } catch (error) {
    console.error('Puppeteer rendering failed:', error);
    throw error; // 上抛异常
  } finally {
    if (page) {
      await page.close();
    }
  }
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// 在应用退出时优雅地关闭浏览器
process.on('exit', closeBrowser);
process.on('SIGINT', closeBrowser);
process.on('SIGTERM', closeBrowser);

module.exports = { renderMermaid, closeBrowser };