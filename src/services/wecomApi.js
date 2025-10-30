const axios = require('axios');
const FormData = require('form-data');

const CORP_ID = process.env.WECOM_CORP_ID;
const AGENT_ID = process.env.WECOM_AGENT_ID;
const APP_SECRET = process.env.WECOM_APP_SECRET;

let cachedToken = null;
let cachedExpire = 0; // epoch seconds

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExpire - 60) {
    return cachedToken;
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${APP_SECRET}`;
  const { data } = await axios.get(url);
  if (data.errcode !== 0) {
    throw new Error(`gettoken error: ${data.errcode} ${data.errmsg}`);
  }
  cachedToken = data.access_token;
  cachedExpire = now + data.expires_in;
  return cachedToken;
}

async function sendTextToUser({ touser, content }) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const payload = {
    touser, // e.g. "userid1|userid2" or "@all"
    msgtype: 'text',
    agentid: Number(AGENT_ID),
    text: { content },
    enable_duplicate_check: 1,
    duplicate_check_interval: 600,
  };
  const { data } = await axios.post(url, payload);
  return data;
}

async function createAppChat({ name, owner, userlist }) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/create?access_token=${token}`;
  const payload = { name, owner, userlist };
  const { data } = await axios.post(url, payload);
  // returns {errcode,errmsg,chatid}
  return data;
}

async function sendTextToChat({ chatid, content }) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${token}`;
  const payload = {
    chatid,
    msgtype: 'text',
    text: { content },
  };
  const { data } = await axios.post(url, payload);
  return data;
}

// 上传图片素材，返回 media_id（临时素材）
async function uploadImage({ buffer, filename = 'image.png' }) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`;
  const form = new FormData();
  form.append('media', buffer, { filename, contentType: 'image/png' });
  const headers = form.getHeaders();
  const { data } = await axios.post(url, form, { headers });
  return data; // {type:"image", media_id, created_at, errcode, errmsg}
}

// 发送图片到用户（应用消息）
async function sendImageToUser({ touser, media_id }) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const payload = {
    touser,
    msgtype: 'image',
    agentid: Number(AGENT_ID),
    image: { media_id },
    enable_duplicate_check: 1,
    duplicate_check_interval: 600,
  };
  const { data } = await axios.post(url, payload);
  return data;
}

// 发送图片到应用群聊
async function sendImageToChat({ chatid, media_id }) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${token}`;
  const payload = {
    chatid,
    msgtype: 'image',
    image: { media_id },
  };
  const { data } = await axios.post(url, payload);
  return data;
}

module.exports = {
  getAccessToken,
  sendTextToUser,
  createAppChat,
  sendTextToChat,
  uploadImage,
  sendImageToUser,
  sendImageToChat,
};