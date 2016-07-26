#!/usr/bin/env node
/*
 * 4get.js
 *
 *
 * (c) jthatch http://github.com/jthatch
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

const fs = require('fs');
const util = require('util');
const path = require('path');
const cluster = require('cluster');
const EventEmitter = require('events').EventEmitter;

const request = require('request');
const chalk = require('chalk');
const cheerio = require('cheerio');


function Forget() {
    this.url = process.argv[2] || "http://boards.4chan.org/fit/thread/38047652/crossfit-cringe-thread";
    this.workers = process.argv[3] || require('os').cpus().length;
    //this.workers = 4;
    this.concurrentDownloads = 8;
    this.retryEvery = 13e3; // 30 secs

    // hard limit
    if (this.workers > 4)
        this.workers = 4;

     // No point having workers that do nothing, so set the no. of concurrent downloads to match the no. of workers
    if (this.workers > this.concurrentDownloads)
        this.concurrentDownloads = this.workers;

    // internal variables
    this._dir = process.cwd() + path.sep;
    this._files = [];
    this._workersFinished = 0;
    this._runEvery = 0;
    this._watch = true;

    this._downloaded = 0;

    EventEmitter.call(this);
}

Forget.prototype.main = function() {
    var _this = this;

    if (!this.validateThreadUrl()) {
        console.log("Error: Invalid thread url");
        process.exit();
    }

    /**
     * Master, responsible for pulling the list of media from the 4chan thread and spinning up and directing workers
     */
    if (cluster.isMaster) {

        console.log("Fetching from "+ this.url + " using " + this.workers + " workers and " + this.concurrentDownloads + " concurrent downloads.");

        // spawn our worker threads immediately as this is non-blocking but takes a little while
        for (var i = 0; i < this.workers; i++) {
            cluster.fork();
        }

        // receive messages from our worker threads, specifically when they've finished downloading a media file
        Object.keys(cluster.workers).forEach(function(id){
            console.log(id + ' cluster');

            cluster.workers[id].on('message', function(msg) {
                if (msg.cmd) {
                    switch (msg.cmd) {
                        case 'downloadFile':
                            _this._downloaded++;
                            console.log('Downloaded ' + msg.data[1]);
                            _this.dispatchDownload(id);
                            break;
                        case 'skippedFile':
                            console.log('Skipped ' + msg.data[1]);
                            _this.dispatchDownload(id);
                            break;
                    }
                }
            });

        });

        //Our first call is to fetch the html of the 4chan thread
        this.fetch();

        //Once we've got the html we can determine if the thread is alive and if so send the html off to be parsed
        this.on('fetch', function(err, response, body) {
            if (err || response.statusCode !== 200) {
                console.log("Thread died");
                clearInterval(_this._runEvery);
                _this._watch = false;
                return false;
            }

            // all looks good, let's test if the thread is archived first
            if (_this.isArchived(body)) {
                _this._watch = false;
                console.log('thread is archived');
            }

            // parse the html and extract all the media
            _this.parse(body);
        });

        this.on('parse', function(files) {
            // if we have files, then let's go ahead and create our directory based on the url
            if (files.length > 0) {
                var dir = this.setAndCreateDir();
                _this.broadcastToWorkers(false, 'dir', dir);
            }

            console.log('found ' + files.length + ' files');
            _this._files = _this._files.concat(_this._files, files);

            /**
             * Initiate the download via the workers
             */
            var lastWorker = 1;
            var downloadsInProgress = 0;
            while ( ( downloadsInProgress < _this.concurrentDownloads ) && _this._files.length ) {
                var file = _this._files.shift();
                lastWorker = lastWorker > _this.workers ? 1 : lastWorker;
                console.log('downloadManager inProgress: ' + downloadsInProgress + ' concurrentDownloads: ' + _this.concurrentDownloads + ' length: ' + _this._files.length + ' file: ' + file + ' lastWorker: ' + lastWorker);
                _this.broadcastToWorkers(lastWorker++, 'downloadFile', file);
                downloadsInProgress++;
            }
        });
        

    }
    // worker
    else {
        // receive messages from master
        process.on('message', function(msg) {
            if (msg.cmd) {
                switch(msg.cmd) {
                    case 'dir':
                        console.log('dir set to: ' + msg.data);
                        _this._dir = msg.data;
                        break;
                    case 'downloadFile':
                        _this.downloadFile(msg.data);
                        break;
                    case 'shutdown':
                        process.disconnect();
                        break;
                    default:
                        console.log('Invalid msg: ' + msg.cmd + ': ' + JSON.stringify(msg.data));
                        break;
                }
            }
        });

        this.on('downloadFile', function (file) {
            _this.broadcastToMaster({cmd: 'downloadFile', data: file});
        });
        this.on('skippedFile', function (file) {
            _this.broadcastToMaster({cmd: 'skippedFile', data: file});
        });

    }
};

/**
 * Dispatch a download to a particular worker assuming there's any files left
 * @param id
 */
Forget.prototype.dispatchDownload = function(id) {
    var _this = this;

    if (this._files.length) {
        var file = this._files.shift();
        this.broadcastToWorkers(id, 'downloadFile', file);
    }
    else {
        if (++this._workersFinished >= this.concurrentDownloads) {
            if (!this._watch) {
                console.log('Thread is archived, shutting down');
                this.broadcastToWorkers(false, 'shutdown');
                clearInterval(this._runEvery);
            }
            else {
                this._workersFinished = 0;
                this._runEvery = setInterval(function(){this.fetch()}, this.retryEvery);
                console.log('trying thread again in 30 secs');
                console.log('finished download : ' + this._downloaded);
            }

        }
    }
};

/**
 * Downloads the file, fileData is an array containing two elements
 * fileData[0] = url
 * fileData[1] = name
 * @param array file
 */
Forget.prototype.downloadFile = function(fileData) {
    var _this = this;

    var url = fileData[0];
    var fileName = this._dir + fileData[1];

    // if the file exists no need to write it again
    try {
        fs.statSync(fileName).isFile();
        _this.emit('skippedFile', fileData);
    }
    // otherwise lets we create a write stream and pipe the file contents to it, emitting once the file has been stored
    catch (e) {
        var fileStream = fs.createWriteStream(fileName);
        fileStream.on('close', function() {
            _this.emit('downloadFile', fileData);
        });
        request
            .get(url)
            .on('error', function(err) {
                console.log(err);
            })
            .pipe(fileStream);
    }
};

/**
 * fetches the html from the remote url
 */
Forget.prototype.fetch = function() {
    var _this = this;
    request({
        method: 'GET',
        timeout :5e3,
        headers: {
            "User-Agent": 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/46.0.2490.80 Safari/537.36'
        },
        url : _this.url
    }, function (err, response, body) {
        _this.emit('fetch', err, response, body);
    });
};

/**
 * Parses the html using the cheerio dom traversal library, allowing us to extract the url's and filenames
 * @param html
 */
Forget.prototype.parse = function(html) {
    var _this = this;

    var $ = cheerio.load(html);
    var files = [];

    $('a.fileThumb').each(function() {
        var a = $(this);
        var url = "http:" + a.attr('href');
        var fileName = url.split('/')[4];

        files.push([url, fileName]);
    });

    _this.emit('parse', files);
    return;
};

/**
 * Creates the directory based on the thread id and name
 * @returns string
 */
Forget.prototype.setAndCreateDir = function() {
    var parts = this.url.split('/');
    this._dir = process.cwd() + path.sep + parts[3] + '_' + parts[6] + '_' + parts[5] + path.sep;
    try {
        fs.statSync(this._dir).isDirectory();
    }
    catch (e) {
        fs.mkdirSync(this._dir, '0755');
    }
    return this._dir;
};

/**
 * Determines if the thread is archived or not
 * @param html
 * @returns int
 */
Forget.prototype.isArchived = function(html) {
    var _this = this;

    var $ = cheerio.load(html);

    return $('.closed').length;
};

Forget.prototype.validateThreadUrl = function() {
    return /https?:\/\/boards.4chan.org\/\S+\/thread\/\d+\/\S+/.test(this.url);
};

/**
 * broadcastToWorkers - if an id is defined we send the payload to only that worker, otherwise it gets broadcasted to all.
 * Returns the number of messages broadcast
 * @param bool|int id
 * @param string
 * @param array|object data
 * @return int
 */
Forget.prototype.broadcastToWorkers = function(id, cmd, data){
    var count = 0;
    // send to a selected worker
    if (id && typeof cluster.workers[id] !== 'undefined') {
        cluster.workers[id].send({ cmd: cmd, data: data });
        count++;
    }
    else {
        // send to all workers
        Object.keys(cluster.workers).forEach(function(id){
            cluster.workers[id].send({cmd : cmd, data : data});
            count++;
        });
    }
    return count;
};

/**
 * broadcastToMaster sends a payload back to our master thread
 * @param array|object payload
 */
Forget.prototype.broadcastToMaster = function(payload) {
    process.send(payload);
};

util.inherits(Forget, EventEmitter);

var forget = new Forget();

forget.main();
