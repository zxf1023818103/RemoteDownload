/**
* @overview 离线下载主js文件
* @author zxf & LuoPing
* @copyright zxf & LuoPing
* @version 1.0.4
 * @readme
* @constructor
 * @todo 1. bt下载和 Metalink 下载有bug，文件读取不到 <-- noSchedule
 * @todo 2. 链接下载会发生 JSONRPC 错误，但会添加下载任务 <-- finish
 * @todo 3. NCHU sso 认证 <-- todo
 * @todo 4. ffmpeg 转码 <-- need Test
*/

'use strict';
// 配置文件
const config = require("./config.json");
// Aria2
// see: https://github.com/sonnyp/aria2.js
// see: https://aria2.github.io
const Aria2 = require('aria2');
const aria2 = new Aria2(config.aria2JsConfig);
// Koa
// see: https://koa.bootcss.com
const Koa = require('koa');
const app = new Koa();
//log | debug
const log4js = require('koa-log4');
const logger = log4js.getLogger('nchu-remote-download-service');
logger.level = 'debug';
// static file
const serve = require('koa-static');
// nodejs path 模块
const path = require('path');
//BodyParser 中间件解析 post 数据
const BodyParser = require('koa-bodyparser');
//定时器
const timers = require('timers');
//others
const _ = require('lodash');
const fs = require('fs');
// koa 封装类
const convert = require('koa-convert');
// koa 路由
const Router = require('koa-router');
const router = Router();
// 邮件通知
// see: https://nodemailer.com/
const nodeMailer = require('nodemailer');
const transporter = nodeMailer.createTransport(config.office365Config);
// 邮箱有效性验证
const validator = require('email-validator');
// ffmpeg js 实现
// 参见：https://github.com/fluent-ffmpeg/node-fluent-ffmpeg
const ffmpeg = require('fluent-ffmpeg');
//mssql
// const Connection = require('tedious').Connection;
// const connection = new Connection(config.mssql);
// ORM 数据库统一连接管理
// see: https://sequelize.org
const Sequelize = require('sequelize');
const sequelize = new Sequelize(config.mssql_sa_orm);
const Request = sequelize.define('RemoteDownloads',{
    MovieName: { type: Sequelize.STRING, allowNull: false, primaryKey: true },
    DownloadLink: {type: Sequelize.STRING, allowNull: true},
    notifyMe: { type: Sequelize.BOOLEAN, allowNull: false,default: false },
    gid: { type: Sequelize.STRING, allowNull: false},
    URL: { type: Sequelize.STRING, allowNull: true },
    userId: { type: Sequelize.INTEGER, allowNull: true },
    email: { type: Sequelize.STRING, allowNull: true },
    status: { type: Sequelize.STRING, allowNull: true }
});
// logger
app.use(async (ctx, next) => {
    const start = new Date();
    await next();
    const ms = new Date() - start;
    logger.debug(`${ctx.method} ${ctx.url} - ${ms}ms`);
});

app.use(convert(BodyParser()));
app.use(router.routes());

// 静态资源目录对于相对入口文件index.js的路径
const staticPath = './public';
app.use(log4js.koaLogger(log4js.getLogger('http'), { level: 'auto' }));
app.use(serve(path.join(__dirname,staticPath)));

/**
 * 获取 post 的数据
 * @return post JSON
 */
// app.use(async (ctx) =>{
//     let postData = ctx.request.body;
//     console.log(postData)
// });
/**
* 处理 Aria2 和 数据库连接，启动网页服务
* @example main()
* @return NULL
*/
async function main() {
    /** 连接数据库 */
    await logger.info('Connecting database...');
     sequelize.authenticate()
         .then(async () => await logger.info('Database connection has been established successfully.'))
         .catch(ConnectionRefusedError => {
             console.log("数据库连接失败！\n请检查数据库是否已启动！");
             console.log(ConnectionRefusedError);
             process.exit(1);
         })
         .catch ( ConnectionError => {
             console.log("目标主机访问失败！");
             console.log(ConnectionError);
             process.exit(1);
         })
         .catch (AccessDeniedError => {
             console.log("数据库访问失败！\n请检查用户名和密码！\n请检查目标主机的目标数据库是否存在或是否有访问权限！");
             console.log(AccessDeniedError);
             process.exit(1);
         })
         .catch(error => {
             console.log(error);
             process.exit(1);
         });
    try {
        await Request.sync();
    } catch (e) {
        logger.error(e);
    }
    try {
        //错误无法使用 try…catch 截获，因为错误是在调用的代码已经退出后抛出的
        logger.info('Connecting to Aria2...');
        await aria2.open();
        let version = await aria2.call('getVersion');
        await logger.info(`Aria2 connected successfully: version ${version.version}`);
    } catch (e) {
        logger.error('Unable to connect aria2: ', e);
    }
    /** 启动网页服务 */
    webServer();
}
/* 注册 Aria2 事件回调函数
status:
                    'onDownloadStart',
                    'onDownloadPause',
                    'onDownloadStop',
                    'onDownloadComplete',
                    'onDownloadError',
                    'onBtDownloadComplete'
                 */
async function handleAria2Event(Name, ctx) {
    aria2.listNotifications().then(notifications => {
        //console.log(notifications);
        notifications.forEach(event => {
            aria2.on(event, async ([gid]) => {
                let status;
                switch (event) {
                    case 'onDownloadStart':
                        status = '下载中';
                        break;
                    case 'onDownloadPause':
                        status = '下载暂停';
                        break;
                    case 'onDownloadStop':
                        status = '下载停止';
                        break;
                    case 'onBtDownloadComplete':
                    case 'onDownloadComplete':
                        status = '下载完成';
                        break;
                    case 'onDownloadError':
                        status = '下载失败';
                        break;
                }
                try{
                //await updateDatabase("status",status,"MovieName",Name, false);
                    Request.sync({force: false})
                        .then(()=>{
                            return Request.update({status: status},{
                                where: {  MovieName: Name } })
                                .catch(err => { console.log(err) });
                        });
                let taskStatus = await aria2.call('tellStatus', gid.gid);
                if (taskStatus.hasOwnProperty('followedBy') && !_.isEmpty(taskStatus.followedBy)){
                    let nextGid = await getFileGid(ctx);
                    Request.sync({force: false})
                        .then(()=>{
                            return Request.update({gid: nextGid},{
                                where: { MovieName: Name } })
                                .catch(err => { console.log(err) });
                        });
                }else{
                    await sendAriaNotification(Name,gid,event);
                }
                }catch(e){logger.error(e);}
            });
        });
    }).catch(err => {
        logger.error(err);
    });
}
/**
 * 通过 orm Sequelize 更新数据库信息
 * @param Col 欲更新的列
 * @param ColValue 更新的值
 * @param id 查找的标识符
 * @param idValue 标识符的值
 * @param boolean 是否强制更新
 * @todo 检查参数值应该为什么样的，直接传参进去无效
 * */
async function updateDatabase(Col,ColValue,id,idValue, boolean){
    Request.sync({force: boolean})
        .then(()=>{
            return Request.update({Col: ColValue},{
                where: {
                    id: idValue
                }
            })
                .catch(err => { console.log(err) });
        })
}

/**
 * 发送邮件通知信息
 * @param movieName 电影名称
 * @param gid 下载文件的 gid
 * @param event aria2 事件
 */
async function sendAriaNotification(movieName, gid, event) {
    let URL = await generatePath(gid);
    console.log(URL);
    if (event === 'onDownloadStart' || event === 'onDownloadComplete' || event === 'onBtDownloadComplete' || event === 'onDownloadError') {
        //let request = await Request.findByPk(Number.parseInt('0x' + gid));
        let request = await Request.findByPk(movieName);
        let status = await aria2.call('tellStatus', request.gid);
        if (request.notifyMe) {
            return transporter.sendMail({
                from: `NCHU Remote Download Service <${config.office365Config.auth.user}>`,
                to: request.email,
                subject: (() => {
                    switch (event) {
                        case 'onDownloadStart':
                            return `${request.MovieName} 下载中`;
                        case 'onDownloadPause':
                            return `${request.MovieName} 下载暂停`;
                        case 'onDownloadStop':
                            return `${request.MovieName} 下载停止`;
                        case 'onBtDownloadComplete':
                        case 'onDownloadComplete':
                            return `${request.MovieName} 下载完成`;
                        case 'onDownloadError':
                            return `${request.MovieName} 下载失败`;
                    }
                })(),
                text: ( () => {
                    switch (event) {
                        case 'onDownloadStart':
                            return `${request.MovieName} 下载中`;
                        case 'onDownloadPause':
                            return `${request.MovieName} 下载暂停。\n如需帮助或有问题请及时联系系统管理员。`;
                        case 'onDownloadStop':
                            return `${request.MovieName} 下载停止。\n如需帮助或有问题请及时联系系统管理员。`;
                        case 'onBtDownloadComplete':
                        case 'onDownloadComplete':
                            Request.sync({force: false})
                                .then(()=>{
                                    return Request.update({URL: URL},{
                                        where: { MovieName: movieName } })
                                        .catch(err => { console.log(err) });
                                });
                            return '任务下载完成，正在等待审核。\n 文件直链：'+ URL;
                        case 'onDownloadError':
                            return '任务下载失败，错误代码：'+status.errorCode+'\n错误原因：'+status.errorMessage;
                    }
                })()
            })
                .catch(e => {
                    console.log("邮箱登录失败！\n请检查用户名和密码！");
                    console.log(e);
                })
        }
    }
}

/**
 * 简单的信息拼接
 * @param movieName 电影名称
 * @param event 事件名称
 * @param message
 * @returns {string}
 */
function messageSplice(movieName, event, message) {
    switch (event) {
        case 'convertStart':
            return movieName + message === ""? message : "转码开始！";
        case 'convertStatus':
            return movieName + message === ""? message : "转码中！";
        case 'error':
            return movieName + message === ""? message : "转码失败！";
        case 'convertFinish':
            return movieName + message === ""? message : "转码完成！";
    }
}

/**
 * 发送转码邮件
 * @param movieName 电影名称
 * @param event 事件名称
 * @param absPath 绝对路径
 * @param titleMessage 邮件标题
 * @param bodyMessage 邮件正文
 */
async function sendConvertNotification(movieName, event,absPath, titleMessage, bodyMessage){
    let request = await Request.findByPk(movieName);
    transporter.sendMail({
        from: `NCHU Remote Download Service <${config.office365Config.auth.user}>`,
        to: request.email,
        subject: (() => { messageSplice(request.MovieName, event, titleMessage) }),
        text: ( () => { messageSplice(request.MovieName, event, bodyMessage) })
    })
        .catch(e => {
            console.log("邮箱登录失败！\n请检查用户名和密码！");
            console.log(e);
        })
}

/**
 * 转码视频
 * @param movieName 视频名称
 * @param absPath 视频的绝对路径
 */
async function transcode(movieName, absPath){
    ffmpeg.setFfmpegPath(config.ffmpegPath);
    ffmpeg.setFfprobePath(config.ffprobePath);
    ffmpeg()
        .input(absPath)
        .ffprobe(function (err, data) {
            if (data.streams[1].codec_name !== "h264"){
                ffmpeg()
                    .input(absPath)
                    .outputFormat('mp4')
                    .videoCodec('libx264')
                    //convertStart
                    .on('start', async function (message) {
                        console.log("start convert !");
                        await sendConvertNotification(movieName, 'convertStart', absPath, "", "")
                    })
                    //convertStatus
                    .on('progress', async function(progress) {
                        console.log('Processing: ' + progress.percent + '% done');
                        //await sendConvertNotification(movieName, 'convertStatus', absPath, "", 'Processing: ' + progress.percent + '% done');
                    })
                    //error
                    .on('error', async function (err, stdout, stderr) {
                        console.log('Cannot convert video: ' + err.message);
                        await sendConvertNotification(movieName, 'error', absPath, "", "");
                    })
                    //convertFinish
                    .on('end', async function(stdout, stderr) {
                        let request = await Request.findByPk(movieName);
                        let URL = await generatePath(request.gid);
                        let convertURL = URL + ".mp4";
                        console.log('Transcoding succeeded !');
                        Request.sync({force: false})
                            .then(()=>{
                                return Request.update({URL: convertURL},{
                                    where: { MovieName: movieName } })
                                    .catch(err => { console.log(err) });
                            });
                        await
                            sendConvertNotification(movieName, 'convertFinish', absPath, "", movieName + "转码完成\n文件直链：" + convertURL);
                    })
                    //saveFile
                    .save(absPath + ".mp4")
                //update database
            }else{
                console.log("end")
            }
        })
        .catch(err => {console.log(err)})
    //.save(path.dirname(absPath) + path.basename(absPath))
}
/**
 * 获取下载文件的 gid
 * @param ctx koa 的 ctx 上下文
 * @todo 检查在一个下载链接多个子下载文件如何获取正确的 gid 值
 * @returns gid 获取下载文件 gid
 */
async function getFileGid(ctx) {
    let gid;
    let type = _.trim(ctx.request.body.type);
    let uris = _.filter(_.trim(ctx.request.body.uris).split(/\r\n|\r|\n/), uri => { return !_.isEmpty(uri); });
    switch (type) {
        case 'uri':
            if (_.isEmpty(uris)) {
                //throw 'Empty uri.';
                console.log("Empty URI!");
            }
            gid = await aria2.call("addUri", uris, config.aria2);
            break;
        case 'torrent':
            console.log(ctx.request.body.torrent);
            gid = await aria2.call('addTorrent', Buffer.from(ctx.request.body.torrent).toString('base64'), config.aria2);
            break;
        case 'metalink':
            gid = await aria2.call('addMetalink', Buffer.from(ctx.request.body.metalink).toString('base64'), config.aria2);
            break;
        default:
            throw `No such type: ${type}.`;
    }
    gid = await getMaxFileGid(gid);
    // let taskStatus = await aria2.call('tellStatus', gid);
    // if (taskStatus.hasOwnProperty('followedBy') && !_.isEmpty(taskStatus.followedBy))
    //     gid = taskStatus.followedBy[0];
    return gid;
}

/**
 * 处理状态码和相应提示信息
 * @param ctx koa 上下文
 * @param statusCode 状态码
 * @param message 提示信息
 */
function handleCtxStatus(ctx,statusCode,message){
    switch (statusCode) {
        case 200:
            ctx.response.status = statusCode;
            ctx.response.body = message ?  message : "任务已提交，还请耐心等待";
            break;
        case 201:
            ctx.response.status = statusCode;
            ctx.response.body = message ?  message : "相同任务已提交，还请耐心等待";
            break;
        case 400:
            ctx.response.status = statusCode;
            ctx.response.body = message ?  message : "please login !";
            break;
        case 500:
            ctx.response.status = statusCode;
            ctx.response.body =  message ?  message : "内部错误";
            break;
    }
}

/**
 * 获取文件大小最大的那个文件的下载 gid
 * @param GID 父GID
 * @returns GID 如果没有 followedBy 属性或者该属性值为空的话 直接返回 GID，否则进行一次 for 循环来筛选出最大长度的文件的 gid 值
 */
async function getMaxFileGid(GID){
    let GIDStatus = await aria2.call('tellStatus', GID);
    if (GIDStatus.hasOwnProperty('followedBy') && !_.isEmpty(GIDStatus.followedBy)){
        let Gid = GIDStatus.followedBy[0];
        let MaxLength =  (await aria2.call('tellStatus', Gid)).files[0].length;
        for (const gid of GIDStatus.followedBy) {
           let gidStatus = await aria2.call('tellStatus', gid);
           if (gidStatus.files[0].length > MaxLength){
               MaxLength = gidStatus.files[0].length;
               Gid = gid;
           }
        }
        return Gid;
        //file.followedBy[0].forEach(gid => {})
    }else{
        return GID;
    }
}
async function generatePath(GID){
    let taskStatus = await aria2.call('tellStatus', GID.gid);
    //console.log(taskStatus);
    let formatPath =  path.relative(config.rootDir,taskStatus.files[0].path);
    return "http://10.1.79.11:8888/" + path.posix(path.normalize(formatPath));
}
/**
* 对于通过 post 方法传递过来的数据进行解析和处理,自定义路由
* @param userID 学号
* @param type 下载类型（http|metaLink|torrent）
* @param ctx.request.body.notifyMe 是否进行通知
* @param email 用户填写的email地址
* @param gid aria2 下载文件是产生的唯一下载任务标识号
* @return NULL
* @example 
* router.post()
*/
router.post('/', async (ctx, next) => {
    if (await checkLogin(ctx)) {
        try {
            let userId = ctx.state.userId;
            const movieName= _.trim(ctx.request.body.movieName);
            /**
            * === 与 = 相比，=== 优先级更高
            * @return boolean "true for notify"
            * @return boolean "false for not notify"
            * */
            let notifyMe = ctx.request.body.notifyMe === 'on';

            console.log("ctx.request.body.notifyMe: "+ctx.request.body.notifyMe+"\nlet notifyMe: "+notifyMe);
            let email;
            if (notifyMe) {
                email = _.trim(ctx.request.body.email);
                if (!validator.validate(email)) {
                    throw `Invalid email address: ${email}.`;
                }
            }
            //let movieName = _.trim(ctx.request.body.movieName);
            //let uris = _.filter(_.trim(ctx.request.body.uris).split(/\r\n|\r|\n/), uri => { return !_.isEmpty(uri); });
            //console.log("Filtered uris: "+uris);

            let request = await Request.findByPk(movieName);
            if (request === null) {
                await handleCtxStatus(ctx, 200, "");
                let gid = await getFileGid(ctx);
                //await console.log("MovieName:" + movieName + "\nuserId:" + userId + "\ngid: " + gid + "\nnotifyMe: " + notifyMe + "\nemail: " + email);
                await Request.create({
                    MovieName: movieName,
                    DownloadLink: ctx.request.body.uris,
                    userId: userId,
                    gid: gid,
                    notifyMe: notifyMe,
                    email: email
                })
                    .catch(ValidationError => {
                        console.log("数据出错，请检查！");
                        console.log(ValidationError);
                    })
                    .catch(UniqueConstrainError => {
                        console.log("已存在相同任务，切勿重复提交！");
                        console.log(UniqueConstrainError);
                    });
            }else if (request.status === "下载完成" || request.status === "下载中"){
                await handleCtxStatus(ctx, 201, "");
                //let request = await Request.findByPk(movieName);
            }else{
                let gid = await getFileGid(ctx);
                // await console.log("MovieName:" + movieName + "\nuserId:" + userId + "\ngid: " + gid + "\nnotifyMe: " + notifyMe + "\nemail: " + email);
                await Request.update({
                    DownloadLink: ctx.request.body.uris,
                    userId: userId,
                    gid: gid,
                    notifyMe: notifyMe,
                    email: email
                },{where: {MovieName: movieName}})
                    //.then(() => console.log("Done!"))
            }
                await handleAria2Event(movieName, ctx);
        } catch (e) {
            handleCtxStatus(ctx, 500, "");
            logger.error(e);
        }
    }
    else {
        handleCtxStatus(ctx,400,"");
    }
});

/**
* 网页服务
* @example webServer()
*/
function webServer() {
    app.listen(config.port, () => {
        logger.info('Service is listening on port: ' + config.port)
    });
}

/**
* 检查校园网登陆状态（nchusso）
* @param ctx  Context（上下文）
* @example checkLogin()
* @return boolean 登陆状态
*/
async function checkLogin(ctx) {
    return true;
    //return await ctx.cookies.get('nchusso') !== undefined;
}

main();

/**
 * ctx statusCode
 100 "continue"
 101 "switching protocols"
 102 "processing"
 200 "ok"
 201 "created"
 202 "accepted"
 203 "non-authoritative information"
 204 "no content"
 205 "reset content"
 206 "partial content"
 207 "multi-status"
 208 "already reported"
 226 "im used"
 300 "multiple choices"
 301 "moved permanently"
 302 "found"
 303 "see other"
 304 "not modified"
 305 "use proxy"
 307 "temporary redirect"
 308 "permanent redirect"
 400 "bad request"
 401 "unauthorized"
 402 "payment required"
 403 "forbidden"
 404 "not found"
 405 "method not allowed"
 406 "not acceptable"
 407 "proxy authentication required"
 408 "request timeout"
 409 "conflict"
 410 "gone"
 411 "length required"
 412 "precondition failed"
 413 "payload too large"
 414 "uri too long"
 415 "unsupported media type"
 416 "range not satisfiable"
 417 "expectation failed"
 418 "I'm a teapot"
 422 "unprocessable entity"
 423 "locked"
 424 "failed dependency"
 426 "upgrade required"
 428 "precondition required"
 429 "too many requests"
 431 "request header fields too large"
 500 "internal server error"
 501 "not implemented"
 502 "bad gateway"
 503 "service unavailable"
 504 "gateway timeout"
 505 "http version not supported"
 506 "variant also negotiates"
 507 "insufficient storage"
 508 "loop detected"
 510 "not extended"
 511 "network authentication required"
 */