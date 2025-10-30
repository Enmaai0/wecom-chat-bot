const express = require('express');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');

// 根据 APP_ENV 加载不同的环境文件，默认 prod
const env = process.env.APP_ENV || 'prod';
const envFile = env === 'dev' ? '.env.dev' : '.env.prod';
dotenv.config({ path: envFile });
console.log(`Loaded env: ${env}, file: ${envFile}`);

const app = express();
app.use(bodyParser.text({ type: '*/*' })); // WeCom posts XML; keep raw text

// Health
app.get('/', (_req, res) => res.send('OK'));

// Placeholder: actual callback logic will be wired via routes/wecom.js
const wecomRouter = require('./routes/wecom');
app.use('/wecom', wecomRouter);

const defaultPort = (process.env.APP_ENV || 'prod') === 'dev' ? 3031 : 3030;
const port = Number(process.env.PORT || defaultPort);
app.listen(port, () => {
  console.log(`Webhook server listening on http://localhost:${port}`);
});