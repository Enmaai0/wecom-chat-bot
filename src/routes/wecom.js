const express = require('express');
const xml2js = require('xml2js');
const { genSignature, aesDecrypt, aesEncrypt } = require('../utils/wecomCrypto');

const router = express.Router();

const CONFIG = {
  token: process.env.WECOM_TOKEN,
  aesKey: process.env.WECOM_ENCODING_AES_KEY,
  corpId: process.env.WECOM_CORP_ID,
  agentId: process.env.WECOM_AGENT_ID,
};

// 测试主动消息发送到群聊会话/成员的演示端点
const api = require('../services/wecomApi');

router.get('/send-demo', async (req, res) => {
  try {
    const { to = '@all', content = 'Hello from webhook demo' } = req.query;
    const data = await api.sendTextToUser({ touser: to, content });
    return res.json(data);
  } catch (e) {
    console.error('send-demo error', e);
    return res.status(500).json({ error: e.message });
  }
});

router.get('/chat-demo', async (req, res) => {
  try {
    const { name = 'demo-chat', owner, users, content = 'Hello AppChat' } = req.query;
    const userlist = (users || '').split('|').filter(Boolean);
    const created = await api.createAppChat({ name, owner, userlist });
    if (created.errcode !== 0) return res.json(created);
    const sent = await api.sendTextToChat({ chatid: created.chatid, content });
    return res.json({ created, sent });
  } catch (e) {
    console.error('chat-demo error', e);
    return res.status(500).json({ error: e.message });
  }
});

// 企业微信 URL 验证（GET）
router.get('/callback', (req, res) => {
  try {
    const { msg_signature, timestamp, nonce, echostr } = req.query;
    const sign = genSignature(CONFIG.token, timestamp, nonce, echostr);
    if (sign !== msg_signature) {
      return res.status(403).send('invalid signature');
    }
    const plain = aesDecrypt(echostr, CONFIG.aesKey, CONFIG.corpId).msg;
    // 按文档要求：返回明文内容，不带引号与换行
    return res.status(200).send(plain);
  } catch (e) {
    console.error('GET verify error:', e);
    return res.status(500).send('error');
  }
});

// 接收消息（POST，xml，Encrypt 字段）并被动回复文本
router.post('/callback', async (req, res) => {
  try {
    // 原始 XML 字符串
    const xml = req.body;
    // 校验签名
    const { msg_signature, timestamp, nonce } = req.query;
    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
    const encrypt = parsed.xml.Encrypt;
    const sign = genSignature(CONFIG.token, timestamp, nonce, encrypt);
    if (sign !== msg_signature) {
      console.warn('signature mismatch');
      return res.status(403).send('invalid signature');
    }

    const decrypt = aesDecrypt(encrypt, CONFIG.aesKey, CONFIG.corpId);
    const innerXml = decrypt.msg;
    const inner = await xml2js.parseStringPromise(innerXml, { explicitArray: false });
    const msgType = inner.xml.MsgType;
    const fromUser = inner.xml.FromUserName;
    const content = inner.xml.Content || '';

    // 为避免超过 5s 超时：快速被动 ACK，异步主动推送 LLM 回复
    let replyContent = '';
    if (msgType === 'text') {
      replyContent = process.env.PASSIVE_ACK_CONTENT || '已收到，正在处理中…';
      setImmediate(async () => {
        try {
          console.log('开始异步处理LLM流式请求，用户:', fromUser, '消息:', content);
          const { chatStream } = require('../services/llm');
          
          // 流式消息状态管理
          let lastSentTime = 0;
          const minInterval = 800; // 控制节流，避免企业微信限速
          let messageQueue = [];
          let isProcessingQueue = false;
          const maxRetries = 3;
          
          const sendWithRetry = async (text) => {
            let attempt = 0;
            while (attempt < maxRetries) {
              try {
                const now = Date.now();
                const timeSinceLastSent = now - lastSentTime;
                if (timeSinceLastSent < minInterval) {
                  await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastSent));
                }
                console.log('发送流式消息片段:', text.substring(0, 50) + '...');
                const sendResult = await api.sendTextToUser({ touser: fromUser, content: text });
                console.log('流式消息发送结果:', sendResult);
                if (sendResult && sendResult.errcode === 0) {
                  lastSentTime = Date.now();
                  return true;
                }
                throw new Error(`wecom send errcode=${sendResult && sendResult.errcode}`);
              } catch (error) {
                attempt++;
                const wait = attempt * 1000; // 递增回退
                console.error(`流式消息发送失败(第${attempt}次):`, error && error.message ? error.message : error);
                await new Promise(resolve => setTimeout(resolve, wait));
              }
            }
            return false;
          };
          
          // 处理消息队列
          const processMessageQueue = async () => {
            if (isProcessingQueue || messageQueue.length === 0) return;
            
            isProcessingQueue = true;
            while (messageQueue.length > 0) {
              const message = messageQueue[0];
              const ok = await sendWithRetry(message);
              if (ok) {
                messageQueue.shift();
              } else {
                // 发送持续失败，记录后继续处理后续片段以避免阻塞
                console.error('片段连续重试仍失败，跳过该片段');
                messageQueue.shift();
              }
            }
            isProcessingQueue = false;
          };
          
          // 流式处理回调函数
          // 判断文本片段是否可能是 mermaid 图定义，若是则不作为文本发送
          const looksLikeMermaid = (t) => {
            if (!t) return false;
            const s = String(t).trim();
            if (!s) return false;
            if (/^```\s*mermaid/i.test(s)) return true;
            const keywords = [
              'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
              'erDiagram', 'gantt', 'journey', 'mindmap', 'quadrantChart', 'pie', 'timeline'
            ];
            if (keywords.some(k => new RegExp(`(^|\n)\s*${k}\b`, 'i').test(s))) return true;
            if (/(-->|---|==>|-\>|\.-\->|\.-\.|:::)/.test(s)) return true; // 常见边/样式语法
            return false;
          };

          const onChunk = async (chunkContent) => {
            try {
              console.log('收到LLM流式内容片段:', chunkContent.substring(0, 50) + '...');
              if (looksLikeMermaid(chunkContent)) {
                console.log('检测到 mermaid 文本片段，跳过文本发送');
                return; // 不入队列，不发送文本
              }
              messageQueue.push(chunkContent);
              processMessageQueue(); // 异步处理队列
            } catch (chunkError) {
              console.error('流式消息队列处理失败:', chunkError);
            }
          };
          
          const { renderMermaid } = require('../services/mermaidRenderer');
          const { extractMermaidBlocks } = require('../utils/mermaid');

          const onComplete = async (finalContent, rawHtml) => {
            console.log('LLM流式响应完成，最终内容长度:', finalContent.length);
            // 等待队列处理完成
            while (isProcessingQueue || messageQueue.length > 0) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            console.log('所有流式消息发送完成');

            // 额外处理：提取 mermaid 代码块并渲染为图片发送
            try {
              const mermaidBlocks = extractMermaidBlocks(finalContent, rawHtml);
              if (mermaidBlocks && mermaidBlocks.length > 0) {
                console.log('检测到 mermaid 代码块数量:', mermaidBlocks.length);
                for (let i = 0; i < mermaidBlocks.length; i++) {
                  const code = mermaidBlocks[i];
                  try {
                    const pngBuffer = await renderMermaid(code);
                    const uploadResult = await api.uploadImage({ buffer: pngBuffer, filename: `mermaid-${Date.now()}.png` });
                    console.log('图片上传结果:', uploadResult);
                    if (uploadResult && uploadResult.errcode === 0 && uploadResult.media_id) {
                      const sendResult = await api.sendImageToUser({ touser: fromUser, media_id: uploadResult.media_id });
                      console.log('图片消息发送结果:', sendResult);
                    } else {
                      console.warn('图片上传失败，无法发送图片消息');
                    }
                  } catch (imgErr) {
                    console.error('Mermaid 渲染或发送失败:', imgErr);
                    // 发送降级文本提示
                    try {
                      await api.sendTextToUser({ touser: fromUser, content: 'Mermaid 图渲染失败，请检查语法。' });
                    } catch (fallbackErr) {
                      console.error('发送降级消息失败:', fallbackErr);
                    }
                  }
                }
              }
            } catch (extractErr) {
              console.error('Mermaid 提取/渲染流程异常:', extractErr);
            }
          };
          
          const onError = async (error) => {
            console.error('LLM流式处理错误:', error);
            // 不清空队列，尽量尝试发送已生成的片段
            // 发送错误回退消息
            try {
              const fallbackResult = await api.sendTextToUser({ 
                touser: fromUser, 
                content: `抱歉，处理您的消息时出现了问题，请稍后重试。` 
              });
              console.log('错误回退消息发送结果:', fallbackResult);
            } catch (fallbackError) {
              console.error('错误回退消息发送失败:', fallbackError);
            }
          };
          
          // 使用流式处理
          await chatStream(content, onChunk, onComplete, onError);
          
        } catch (err) {
          console.error('Async LLM/send error:', err);
          // 回退为简单回显
          try {
            console.log('尝试发送回退消息给用户:', fromUser);
            const fallbackResult = await api.sendTextToUser({ touser: fromUser, content: `收到你的消息：${content}` });
            console.log('回退消息发送结果:', fallbackResult);
          } catch (e2) {
            console.error('Fallback send error:', e2);
          }
        }
      });
    } else {
      replyContent = `暂不支持 ${msgType}，请发送文本`;
    }

    // 组装被动回复包（加密）
    const respXml = `\n<xml>\n  <ToUserName><![CDATA[${fromUser}]]></ToUserName>\n  <FromUserName><![CDATA[${CONFIG.corpId}]]></FromUserName>\n  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>\n  <MsgType><![CDATA[text]]></MsgType>\n  <Content><![CDATA[${replyContent}]]></Content>\n</xml>`;

    const encryptResp = aesEncrypt(respXml, CONFIG.aesKey, CONFIG.corpId);
    const respSign = genSignature(CONFIG.token, timestamp, nonce, encryptResp);
    const final = `\n<xml>\n  <Encrypt><![CDATA[${encryptResp}]]></Encrypt>\n  <MsgSignature><![CDATA[${respSign}]]></MsgSignature>\n  <TimeStamp>${timestamp}</TimeStamp>\n  <Nonce><![CDATA[${nonce}]]></Nonce>\n</xml>`;

    res.set('Content-Type', 'text/xml');
    return res.status(200).send(final);
  } catch (e) {
    console.error('POST callback error:', e);
    // 如果超时或异常，按文档可返回空串以避免重试阻塞
    return res.status(200).send('');
  }
});

module.exports = router;