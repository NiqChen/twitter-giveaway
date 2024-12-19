const { Scraper, SearchMode } = require('agent-twitter-client');
const { Cookie } = require('tough-cookie');
require('dotenv').config();
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');
const fs = require('fs');

const COOKIES_PATH = path.resolve(__dirname, '../cookies.json');

function jsonToCookieStrings(cookiesJson) {
  return cookiesJson.map(cookieJson => {
    const cookie = new Cookie({
      key: cookieJson.key,
      value: cookieJson.value,
      domain: cookieJson.domain,
      path: cookieJson.path,
      secure: cookieJson.secure,
      httpOnly: cookieJson.httpOnly,
      expires: cookieJson.expires ? new Date(cookieJson.expires) : null,
      maxAge: cookieJson.maxAge,
      sameSite: cookieJson.sameSite
    });
    return cookie.toString();
  });
}

class TwitterRepliesCollector {
    constructor() {
        this.scraper = new Scraper();
    }

    async initialize() {
        try {
            if (fs.existsSync(COOKIES_PATH)) {
                console.log('发现 cookies.json，尝试使用 cookie 登录');
                const cookies = require(COOKIES_PATH);
                await this.scraper.setCookies(jsonToCookieStrings(cookies));
            } else {
                console.log('未找到 cookies.json，使用账号密码登录');
                await this.scraper.login(process.env.TWITTER_USERNAME, process.env.TWITTER_PASSWORD);
                const cookies = await this.scraper.getCookies();
                fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
                console.log('已保存 cookies 到 cookies.json');
            }
            console.log('登录成功');
        } catch (error) {
            console.error('登录失败:', error);
            throw error;
        }
    }

    async getReplies(tweetId) {
        try {
            const query = `conversation_id:${tweetId}`;
            console.log(`开始搜索推文回复，查询条件: ${query}`);

            const tweets = await this.scraper.searchTweets(query, 10, SearchMode.Latest);
            const replies = [];
            
            for await (const tweet of tweets) {
                if (tweet && tweet.username !== process.env.TWITTER_USERNAME) {
                    console.log(`找到其他用户的回复: ${tweet.username}`);
                    replies.push(tweet);
                }
            }

            return replies;
        } catch (error) {
            console.error('获取回复时出错:', error);
            return [];
        }
    }
}

function validateEnvVars() {
  const requiredEnvVars = [
    'TWITTER_USERNAME',
    'TWITTER_PASSWORD',
    'TWITTER_EMAIL',
    'TWEET_ID'
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.error(`请在 .env 文件中设置 ${envVar}`);
      process.exit(1);
    }
  }
}

async function exportRepliesToCsv(replies) {
  const csvWriter = createObjectCsvWriter({
    path: path.resolve(__dirname, 'replies.csv'),
    header: [
      { id: 'username', title: 'Username' },
      { id: 'text', title: 'Text' },
      { id: 'timestamp', title: 'Timestamp' },
      { id: 'urls', title: 'URLs' },
      { id: 'html', title: 'HTML' }
    ]
  });

  const records = replies.map((reply) => ({
    username: reply.username || 'unknown',
    text: reply.text || '',
    timestamp: reply.timestamp || '',
    urls: Array.isArray(reply.urls) ? reply.urls.join(', ') : '',
    html: reply.html || ''
  }));

  await csvWriter.writeRecords(records);
  console.log('数据已成功写入 replies.csv 文件');
}

async function main() {
  try {
    validateEnvVars();
    const collector = new TwitterRepliesCollector();
    await collector.initialize();
    const replies = await collector.getReplies(process.env.TWEET_ID);
    console.log(`搜索到 ${replies.length} 条回复`);
    
    if (replies.length > 0) {
      await exportRepliesToCsv(replies);
      console.log(`已导出 ${replies.length} 条回复到 CSV 文件`);
    } else {
      console.log('没有找到符合条件的回复');
    }
  } catch (error) {
    console.error('执行出错:', error);
    process.exit(1);
  }
}

// 启动程序
main().catch((err) => {
  console.error('执行出错:', err);
  process.exit(1);
});