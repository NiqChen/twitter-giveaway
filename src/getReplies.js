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

async function initializeScraper() {
  const scraper = new Scraper();
  
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      console.log('发现 cookies.json，尝试使用 cookie 登录');
      const cookies = require(COOKIES_PATH);
      await scraper.setCookies(jsonToCookieStrings(cookies));
    } else {
      console.log('未找到 cookies.json，使用账号密码登录');
      await scraper.login(process.env.TWITTER_USERNAME, process.env.TWITTER_PASSWORD);
      const cookies = await scraper.getCookies();
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
      console.log('已保存 cookies 到 cookies.json');
    }
    console.log('登录成功');
    return scraper;
  } catch (error) {
    console.error('登录失败:', error);
    throw error;
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

async function getReplies(scraper, tweetId) {
  try {
    const query = `conversation_id:${tweetId}`;
    console.log(`开始搜索推文回复，查询条件: ${query}`);

    // 检查 scraper 实例
    console.log('检查 scraper 方法:', Object.keys(scraper));
    console.log('searchTweets 类型:', typeof scraper.searchTweets);

    // 获取推文生成器
    console.log('正在创建推文生成器...');
    let tweetGenerator;
    try {
      tweetGenerator = scraper.searchTweets(query, 10, SearchMode.Latest);
      console.log('推文生成器类型:', typeof tweetGenerator);
      console.log('推文生成器方法:', Object.keys(tweetGenerator));
      
      // 检查是否是异步迭代器
      console.log('是否有 Symbol.asyncIterator:', !!tweetGenerator[Symbol.asyncIterator]);
      console.log('是否有 next 方法:', !!tweetGenerator.next);
      
      if (!tweetGenerator[Symbol.asyncIterator]) {
        throw new Error('推文生成器不是有效的异步迭代器');
      }
    } catch (genError) {
      console.error('创建推文生成器失败:', genError);
      throw genError;
    }

    const replies = [];
    console.log('开始获取推文...');
    
    try {
      console.log('开始遍历推文...');
      let result;
      let count = 0;
      const MAX_ATTEMPTS = 20; // 设置最大尝试次数

      while (count < MAX_ATTEMPTS) {
        count++;
        console.log(`尝试获取第 ${count} 条推文...`);
        
        try {
          result = await tweetGenerator.next();
          console.log('获取结果:', result);
          
          if (result.done) {
            console.log('迭代完成');
            break;
          }

          const tweet = result.value;
          console.log('收到推文:', tweet ? '有数据' : '空数据');
          
          if (tweet && tweet.username !== process.env.TWITTER_USERNAME) {
            console.log(`找到其他用户的回复: ${tweet.username}`);
            replies.push(tweet);
          }
        } catch (nextError) {
          console.error(`第 ${count} 次获取推文时出错:`, nextError);
          break;
        }
      }
      
      if (count >= MAX_ATTEMPTS) {
        console.log('达到最大尝试次数，停止获取');
      }
    } catch (iterError) {
      console.error('遍历推文出错:', iterError);
      console.error('错误类型:', iterError.constructor.name);
      console.error('错误信息:', iterError.message);
      console.error('错误堆栈:', iterError.stack);
      throw iterError;
    }

    console.log(`��理完成，共找到 ${replies.length} 条回复`);
    return replies;
  } catch (error) {
    console.error('获取回复时出错:', error);
    console.error('错误堆栈:', error.stack);
    return [];
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
    const scraper = await initializeScraper();
    
    const tweetId = process.env.TWEET_ID;
    console.log('开始获取推文回复...');
    
    const replies = await getReplies(scraper, tweetId);
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