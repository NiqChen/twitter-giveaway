const fs = require("fs");
const { Scraper, SearchMode } = require('agent-twitter-client');
const { Cookie } = require('tough-cookie');
const { TweetModel } = require("../models/tweet");
const mongoose = require("mongoose");
const { timeout } = require("../utils/timeout");
const { logger } = require("../logs/logger");

class Twitter {

    constructor() {
        const scraper = new Scraper();
        this.scraper = scraper;
        this.replyTimeCache = {};       // 保存上一次回复的时间，快速筛选出最新的回复
    }

    jsonToCookieStrings(cookiesJson) {
        return cookiesJson.map(cookieJson => {
            // 使用 tough-cookie 创建 Cookie 对象
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
    
            // 返回 Cookie 的字符串形式
            return cookie.toString(); // 仅 key=value
            // return cookie.toHeader(); // 完整 Set-Cookie 字符串
        });
    }

    async loginTwitter() {
        if (fs.existsSync("./cookies.json")) {
            const cookies = require("./cookies.json");
            await this.scraper.setCookies(
                this.jsonToCookieStrings(cookies)
            );
            return;
        }


        await this.scraper.login(process.env.TWITTER_USERNAME, process.env.TWITTER_PASSWORD);
        const cookies = await this.scraper.getCookies();
        fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
        await this.scraper.setCookies(
            this.jsonToCookieStrings(cookies)
        );
    }


    async getMyTweets() {
        const tweets = await TweetModel.find({
            tweeterUsername: process.env.TWITTER_USERNAME
        });
        return tweets.filter(tweet => {
            return new Date(tweet.createdAt).getTime() > new Date(Date.now() - 1000 * 60 * 60 * 24 * 3)
        });
    }


    async getMyTweetReplies(tweetId) {
        const query = `conversation_id:${tweetId}`;
        logger.info(`开始搜索推文回复，查询条件: ${query}`);
        console.log(`开始搜索推文回复，查询条件: ${query}`);

        const tweets = await this.scraper.searchTweets(query, 100, SearchMode.Latest);
        logger.info(`搜索到 ${tweets.length} 条推文`);
        console.log(`搜索到 ${tweets.length} 条推文`);
        
        const tweetsList = [];
        for await(const tweetItem of tweets) {
            if (tweetItem.username === process.env.TWITTER_USERNAME) {
                logger.info(`跳过自己的推文: ${tweetItem.username} - ${tweetItem.html}`);
                console.log(`跳过自己的推文: ${tweetItem.username} - ${tweetItem.html}`);
                continue;
            }
            logger.info(`找到其他用户的回复: ${tweetItem.username} - ${tweetItem.html}`);
            console.log(`找到其他用户的回复: ${tweetItem.username} - ${tweetItem.html}`);
            tweetsList.push(tweetItem);
        }

        logger.info(`最终收集到 ${tweetsList.length} 条其他用户的回复`);
        console.log(`最终收集到 ${tweetsList.length} 条其他用户的回复`);
        return tweetsList;
    }

    async getAllMyTweets() {
        const tweets = await this.scraper.getTweets(process.env.TWITTER_USERNAME, 100);
        const tweetsList = [];
        for await(const tweetItem of tweets) {
            tweetsList.push(tweetItem);
        }
    
        return tweetsList;
    }

    async getMostLatestMyTweet(conversationId, searchText) {
        let tweets = [];
        if (conversationId) {
            const query = `conversation_id:${conversationId}`;
            tweets = await this.scraper.searchTweets(query, 10, SearchMode.Latest)
        } else {
            tweets = await this.scraper.getTweets(process.env.TWITTER_USERNAME, 10);
        }

        const tweetsList = [];
        for await (const tweetItem of tweets) {
            if (tweetItem.username === process.env.TWITTER_USERNAME) {
                tweetsList.push(tweetItem);
            }
        }
        if (tweetsList.length === 0) {
            return null;
        }

        return tweetsList[0];
    }

    async getTweetLinks(tweetLinks, tweetId) {
        if (!tweetId) {
            return [...tweetLinks];
        }
        
        const tweet = await TweetModel.findOne({
            tweetId
        });
    
        if (!tweet) {
            return [...tweetLinks];
        }
        return this.getTweetLinks([tweet.tweet, ...tweetLinks], tweet.replyTo);
    }

    /**
     * 获得最新的回复
     * @returns 
     */
    async getLatestReplies() {
        const tweets = await this.getMyTweets();
        const latestReplies = [];
        for (let tweet of tweets) {
            const replies = await this.getMyTweetReplies(tweet.tweetId);
            const newReplies = [];
            for (let reply of replies) {

                if (reply.timestamp * 1000 < new Date(process.env.SERVICE_FROM).getTime()) {
                    continue;
                }

                if (await TweetModel.exists({
                    tweetId: reply.id
                })) {
                    continue;
                }
                newReplies.push(reply);
            }
            latestReplies.push(...newReplies);
        }
        const latestRepliesLinks = [];
        // 获得reply的链条
        for (let reply of latestReplies) {
            const links = await this.getTweetLinks([], reply.conversationId);

            latestRepliesLinks.push([
                ...links,
                reply
            ]);
        }
        return latestRepliesLinks;
    }

    /**
     * 获得提及的推特
     */
    async getLatestReferTweets() {
        const query = `@${process.env.TWITTER_USERNAME}`;
        const tweets = await this.scraper.searchTweets(query, 100, SearchMode.Latest);
        const tweetsList = [];
        for await(const tweetItem of tweets) {
            if (!tweetItem.isReply && tweetItem.username !== process.env.TWITTER_USERNAME) {

                if (tweetItem.timestamp * 1000 < new Date(process.env.SERVICE_FROM).getTime()) {
                    continue;
                }

                const exists = await TweetModel.exists({
                    tweetId: tweetItem.id
                });
                if (exists) {
                    continue;
                }
                
                tweetsList.push(tweetItem);
            }
        }
        return tweetsList;
    }

    /**
     * 
     * @param {*} text 
     * @param {*} images 
     * @param { [{ data: Buffer, mediaType: String }] } replyTo 
     * @returns 
     */
    async publishTweet(
        text,
        images,
        replyTo,
        character,
        conversationId = null
    ) {
        const replyToTweet = replyTo ? await TweetModel.findOne({
            tweetId: replyTo
        }) : null;
        await this.scraper.sendTweet(text, replyTo, images.slice(0, 4));
        await timeout(10000);
        const tweet = await this.getMostLatestMyTweet(conversationId, text);

        if (!tweet) {
            throw new Error("tweet not found");
        }

        await TweetModel.create({
            tweetId: tweet.id,
            tweetPubDate: tweet.timestamp * 1000,
            tweeterUsername: tweet.username,
            sender: null,
            html: tweet.html,
            replyTo: replyToTweet ? replyToTweet._id : null,
            tweet,
            character
        });
        return tweet;
    }
}


module.exports = {
    twitterService: new Twitter()
}

