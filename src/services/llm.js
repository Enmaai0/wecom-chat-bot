const axios = require('axios');

const LLM_URL = process.env.LLM_URL || '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 600000); // 600秒
const MAX_SEGMENT_BYTES = 2000;

// 原有的chat函数，返回完整响应
async function chat(userMessage) {
  const payload = { user_message: userMessage || '' };
  
  // 重试机制
  const maxRetries = 2;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`LLM请求尝试 ${attempt}/${maxRetries}...`);
      console.log('请求URL:', LLM_URL);
      console.log('请求payload:', JSON.stringify(payload));
      console.log('超时设置:', LLM_TIMEOUT_MS, 'ms');
      
      const response = await axios.post(LLM_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: LLM_TIMEOUT_MS,
        responseType: 'stream', // 处理流式响应
      });

      console.log('收到响应，开始处理流式数据...');
      
      // 收集流式数据
      let result = '';
      return new Promise((resolve, reject) => {
        let timeout = setTimeout(() => {
          console.log('流式响应超时，已等待', LLM_TIMEOUT_MS, 'ms');
          reject(new Error('Stream timeout'));
        }, LLM_TIMEOUT_MS);

        response.data.on('data', (chunk) => {
          // 接收到数据时重置超时计时器
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            console.log('流式响应超时，已等待', LLM_TIMEOUT_MS, 'ms');
            reject(new Error('Stream timeout'));
          }, LLM_TIMEOUT_MS);
          
          const chunkStr = chunk.toString();
          console.log('收到数据块，长度:', chunkStr.length);
          result += chunkStr;
        });
        
        response.data.on('end', () => {
          clearTimeout(timeout);
          console.log('流式响应结束，总长度:', result.length);
          
          try {
            // 解析HTML格式的响应，提取实际内容
            const extractedContent = extractContentFromHtml(result);
            console.log('LLM响应成功');
            resolve(extractedContent || '收到消息，但LLM返回为空');
          } catch (parseError) {
            console.error('Parse error:', parseError);
            // 如果解析失败，返回原始内容的清理版本
            const cleaned = result.trim();
            resolve(cleaned || '收到消息，但LLM返回为空');
          }
        });
        
        response.data.on('error', (error) => {
          clearTimeout(timeout);
          console.error('Stream error:', error);
          reject(error);
        });
      });
    } catch (error) {
      lastError = error;
      console.error(`LLM请求尝试 ${attempt} 失败:`, error.message);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 1000; // 递增等待时间
        console.log(`等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 所有重试都失败了
  console.error('所有LLM请求尝试都失败了');
  throw lastError;
}

// 新增的流式chat函数，支持实时回调
async function chatStream(userMessage, onChunk, onComplete, onError) {
  const payload = { user_message: userMessage || '' };
  
  // 重试机制
  const maxRetries = 2;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`LLM流式请求尝试 ${attempt}/${maxRetries}...`);
      console.log('请求URL:', LLM_URL);
      console.log('请求payload:', JSON.stringify(payload));
      console.log('超时设置:', LLM_TIMEOUT_MS, 'ms');
      
      const response = await axios.post(LLM_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: LLM_TIMEOUT_MS,
        responseType: 'stream', // 处理流式响应
      });

      console.log('收到响应，开始处理流式数据...');
      
      // 处理流式数据
      let result = '';
      let chunkBuffer = '';
      let plainBuffer = '';
      
      return new Promise((resolve, reject) => {
        let timeout = setTimeout(() => {
          console.log('流式响应超时，已等待', LLM_TIMEOUT_MS, 'ms');
          const error = new Error('Stream timeout');
          if (onError) onError(error);
          reject(error);
        }, LLM_TIMEOUT_MS);

        response.data.on('data', (chunk) => {
          // 接收到数据时重置超时计时器
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            console.log('流式响应超时，已等待', LLM_TIMEOUT_MS, 'ms');
            const error = new Error('Stream timeout');
            if (onError) onError(error);
            reject(error);
          }, LLM_TIMEOUT_MS);
          
          const chunkStr = chunk.toString();
          console.log('收到数据块，长度:', chunkStr.length);
          result += chunkStr;
          chunkBuffer += chunkStr;

          // 从缓冲区中提取完整的标签模块
          const { modules, remainder } = extractCompleteModules(chunkBuffer);
          chunkBuffer = '';
          // 余下的非标签文本累计到 plainBuffer
          if (remainder && remainder.trim()) {
            plainBuffer += sanitizeModuleText(remainder);
          }
          for (const m of modules) {
            const text = sanitizeModuleText(m.raw);
            if (text && text.trim()) {
              const parts = splitByBytes(text, MAX_SEGMENT_BYTES);
              for (const p of parts) {
                if (onChunk) onChunk(p);
              }
            }
          }

          // 当纯文本累计超出阈值时，切片发送，保留尾部作为下一次缓冲
          while (Buffer.byteLength(plainBuffer, 'utf8') > MAX_SEGMENT_BYTES) {
            const buf = Buffer.from(plainBuffer, 'utf8');
            const head = buf.subarray(0, MAX_SEGMENT_BYTES).toString('utf8');
            const tail = buf.subarray(MAX_SEGMENT_BYTES).toString('utf8');
            if (onChunk) onChunk(head);
            plainBuffer = tail;
          }
        });
        
        response.data.on('end', () => {
          clearTimeout(timeout);
          console.log('流式响应结束，总长度:', result.length);
          
          try {
            // 处理剩余的缓冲区内容：尝试提取未闭合的标签模块，并发送纯文本尾部
            if (chunkBuffer && chunkBuffer.trim()) {
              const incompleteModules = extractIncompleteModules(chunkBuffer);
              for (const m of incompleteModules) {
                const text = sanitizeModuleText(m.raw);
                if (text && text.trim()) {
                  const parts = splitByBytes(text, MAX_SEGMENT_BYTES);
                  for (const p of parts) {
                    if (onChunk) onChunk(p);
                  }
                }
              }
            }
            if (plainBuffer && plainBuffer.trim()) {
              const parts = splitByBytes(plainBuffer, MAX_SEGMENT_BYTES);
              for (const p of parts) {
                if (onChunk) onChunk(p);
              }
              plainBuffer = '';
            }
            
            // 解析完整响应
            const extractedContent = extractContentFromHtml(result);
            console.log('LLM流式响应完成');
            if (onComplete) {
              // 额外传递原始HTML内容，便于上层提取 mermaid 等特殊块
              onComplete((extractedContent || '收到消息，但LLM返回为空'), result);
            }
            resolve(extractedContent || '收到消息，但LLM返回为空');
          } catch (parseError) {
            console.error('Parse error:', parseError);
            const error = parseError;
            if (onError) onError(error);
            reject(error);
          }
        });
        
        response.data.on('error', (error) => {
          clearTimeout(timeout);
          console.error('Stream error:', error);
          if (onError) onError(error);
          reject(error);
        });
      });
    } catch (error) {
      lastError = error;
      console.error(`LLM流式请求尝试 ${attempt} 失败:`, error.message);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 1000; // 递增等待时间
        console.log(`等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 所有重试都失败了
  console.error('所有LLM流式请求尝试都失败了');
  if (onError) onError(lastError);
  throw lastError;
}

function extractCompleteModules(buffer) {
  let modules = [];
  let cursor = 0;
  while (true) {
    const openIdx = buffer.indexOf('<', cursor);
    if (openIdx === -1) break;
    const gtIdx = buffer.indexOf('>', openIdx + 1);
    if (gtIdx === -1) break;
    const tagHead = buffer.slice(openIdx + 1, gtIdx).trim();
    if (!tagHead || tagHead.startsWith('/')) { cursor = gtIdx + 1; continue; }
    const tagName = tagHead.split(/\s+/)[0];
    const closeTag = `</${tagName}>`;
    let searchPos = gtIdx + 1;
    let depth = 1;
    let foundCloseIdx = -1;
    while (true) {
      const nextOpen = buffer.indexOf(`<${tagName}`, searchPos);
      const nextClose = buffer.indexOf(closeTag, searchPos);
      if (nextClose === -1) { foundCloseIdx = -1; break; }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        searchPos = nextOpen + 1;
      } else {
        depth--;
        searchPos = nextClose + closeTag.length;
        if (depth === 0) { foundCloseIdx = nextClose; break; }
      }
    }
    if (foundCloseIdx === -1) break;
    const innerStart = gtIdx + 1;
    const innerEnd = foundCloseIdx;
    const innerRaw = buffer.slice(innerStart, innerEnd);
    modules.push({ tag: tagName, raw: innerRaw });
    buffer = buffer.slice(0, openIdx) + buffer.slice(foundCloseIdx + closeTag.length);
    cursor = 0;
  }
  return { modules, remainder: buffer };
}

function extractIncompleteModules(buffer) {
  let modules = [];
  let cursor = 0;
  while (true) {
    const openIdx = buffer.indexOf('<', cursor);
    if (openIdx === -1) break;
    const gtIdx = buffer.indexOf('>', openIdx + 1);
    if (gtIdx === -1) break;
    const tagHead = buffer.slice(openIdx + 1, gtIdx).trim();
    if (!tagHead || tagHead.startsWith('/')) { cursor = gtIdx + 1; continue; }
    const tagName = tagHead.split(/\s+/)[0];
    const closeTag = `</${tagName}>`;
    const closeIdx = buffer.indexOf(closeTag, gtIdx + 1);
    if (closeIdx !== -1) { cursor = gtIdx + 1; continue; }
    const innerRaw = buffer.slice(gtIdx + 1);
    modules.push({ tag: tagName, raw: innerRaw });
    buffer = buffer.slice(0, openIdx);
    cursor = 0;
  }
  return modules;
}

function sanitizeModuleText(raw) {
  let content = raw || '';
  content = content.replace(/<[^>]*>/g, '');
  content = content.replace(/[ \t]+/g, ' ');
  content = content.replace(/\r?\n/g, '\n');
  content = content.trim();
  return content;
}

function splitByBytes(text, maxBytes) {
  const parts = [];
  if (!text) return parts;
  let start = 0;
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const b = Buffer.byteLength(ch, 'utf8');
    if (acc + b > maxBytes) {
      parts.push(text.slice(start, i));
      start = i;
      acc = b;
    } else {
      acc += b;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

// 从HTML格式的响应中提取实际内容
function extractContentFromHtml(htmlContent) {
  try {
    let buffer = htmlContent || '';
    const { modules } = extractCompleteModules(buffer);
    const texts = modules.map(m => sanitizeModuleText(m.raw)).filter(t => t && t.trim());
    if (texts.length === 0) {
      const fallback = buffer.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      return fallback || '已收到您的消息，正在处理中...';
    }
    return texts.join('\n\n');
  } catch (error) {
    console.error('Content extraction error:', error);
    return '已收到您的消息，正在处理中...';
  }
}

module.exports = { chat, chatStream };