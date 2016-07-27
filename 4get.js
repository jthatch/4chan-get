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


function Fourget() {
	this.url = process.argv[2] || "http://boards.4chan.org/fit/thread/38047652/crossfit-cringe-thread";
	this.workers = process.argv[3] || require('os').cpus().length;
	this.concurrentDownloads = 8;
	this.retryEvery = 3e3; // 30 secs
	this.useOriginal = true;

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
	this._startTime = new Date().getTime();

	EventEmitter.call(this);
}

Fourget.prototype.main = function() {
	var _this = this;

	if (!this.validateThreadUrl()) {
		_this.log("c:bgRed", "Error! Please supply a valid 4chan thread!");
		_this.usage();
		process.exit();
	}

	/**
	 * Master, responsible for pulling the list of media from the 4chan thread and spinning up and directing workers
	 */
	if (cluster.isMaster) {

		_this.log("Fetching from ", "c:green underline", this.url,
			" using ", "c:green underline", this.workers, " workers and ",
			"c:green underline", this.concurrentDownloads, " concurrent downloads.");

		// spawn our worker threads immediately as this is non-blocking but takes a little while
		for (var i = 0; i < this.workers; i++) {
			cluster.fork();
		}

		// receive messages from our worker threads, specifically when they've finished downloading a media file
		Object.keys(cluster.workers).forEach(function(id){
			_this.log("c:bgBlue bold", "worker #" + id + ' is online');

			cluster.workers[id].on('message', function(msg) {
				if (msg.cmd) {
					switch (msg.cmd) {
						case 'downloadFile':
							_this._downloaded++;
							_this.log("c:green", "Downloaded ", "c:green bold", msg.data.fileName,
								"c:green", " in " + _this.runTime(msg.data.duration));
							_this.dispatchDownload(id);
							break;
						case 'skippedFile':
							_this.log("c:blue", "Skipped ", "c:blue bold", msg.data.fileName);
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
				_this.log("c:red bold", "Thread has died, shutting down..");
				clearInterval(_this._runEvery);
				_this._watch = false;
				return false;
			}

			// all looks good, let's test if the thread is archived first
			if (_this.isArchived(body)) {
				_this._watch = false;
				//_this.log("c:yellow", "Thread is archived, closing down...");
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

			_this.log("c:bgGreen bold", 'Found ' + files.length + ' files');
			_this._files = _this._files.concat(_this._files, files);

			/**
			 * Initiate the download via the workers
			 */
			var lastWorker = 1;
			var downloadsInProgress = 0;
			while ( ( downloadsInProgress < _this.concurrentDownloads ) && _this._files.length ) {
				var file = _this._files.shift();
				lastWorker = lastWorker > _this.workers ? 1 : lastWorker;
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
						_this._dir = msg.data;
						break;
					case 'downloadFile':
						_this.downloadFile(msg.data);
						break;
					case 'shutdown':
						process.disconnect();
						break;
					default:
						_this.log('Invalid msg: ' + msg.cmd + ': ' + JSON.stringify(msg.data));
						break;
				}
			}
		});

		this.on('downloadFile', function (file) {
			_this.broadcastToMaster('downloadFile', file);
		});
		this.on('skippedFile', function (file) {
			_this.broadcastToMaster('skippedFile', file);
		});

	}
};

/**
 * Dispatch a download to a particular worker assuming there's any files left
 * @param id
 */
Fourget.prototype.dispatchDownload = function(id) {
	var _this = this;

	if (this._files.length) {
		var file = this._files.shift();
		this.broadcastToWorkers(id, 'downloadFile', file);
	}
	else {
		if (++this._workersFinished >= this.concurrentDownloads) {
			if (!this._watch) {
				_this.log("c:yellow bold", "Thread is archived, closing down...");
				_this.log();
				_this.log("c:blue bold", "Downloaded " + _this._downloaded + " files in " + _this.runTime());
				this.broadcastToWorkers(false, 'shutdown');
				clearInterval(this._runEvery);
			}
			else {
				this._workersFinished = 0;
				this._runEvery = setInterval(function(){_this.fetch()}, this.retryEvery);
				_this.log();
				_this.log("c:blue bold", "Downloaded " + _this._downloaded + " files in " + _this.runTime());
				_this.log();
				_this.log('c:cyan bold', 'Trying thread again in ' + _this.retryEvery + " seconds");
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
Fourget.prototype.downloadFile = function(fileData) {
	var _this = this;
	var startTime = new Date().getTime();

	var url = fileData[0];
	var fileName = fileData[1];
	var file = this._dir + fileName;

	// if the file exists no need to write it again
	try {
		fs.statSync(file).isFile();
		_this.emit('skippedFile', {url: url, fileName: fileName});
	}
		// otherwise lets we create a write stream and pipe the file contents to it, emitting once the file has been stored
	catch (e) {
		var fileStream = fs.createWriteStream(file);
		fileStream.on('close', function() {
			_this.emit('downloadFile', {url: url, fileName: fileName, duration: startTime});
		});
		request
			.get(url)
			.on('error', function(err) {
				_this.log(err);
				_this.emit('skippedFile', {url: url, fileName: fileName});
			})
			.pipe(fileStream);
	}
};

/**
 * fetches the html from the remote url
 */
Fourget.prototype.fetch = function() {
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
Fourget.prototype.parse = function(html) {
	var _this = this;

	var $ = cheerio.load(html);
	var files = [];
	/*
	 <div class="file" id="f6581245">
	 <div class="fileText" id="fT6581245">
	 File: <a href="//i.4cdn.org/wg/1464147906056.jpg" target="_blank">423567971.jpg</a> (331 KB, 1920x1080)
	 </div>
	 <a class="fileThumb" href="//i.4cdn.org/wg/1464147906056.jpg" target="_blank">
	 <img src="//i.4cdn.org/wg/1464147906056s.jpg" alt="331 KB" data-md5="e3K+/kqjwyn58B86sDw4+w==" style="height: 140px; width: 250px;">
	 <div data-tip="" data-tip-cb="mShowFull" class="mFileInfo mobile">331 KB JPG</div>
	 </a>
	 </div>
	 */

	$('div.file').each(function(){
		var a = $(this),
			url = 'http:' + a.find('a.fileThumb').attr('href');
		var fileName;

		if (_this.useOriginal) {
			if (! (fileName = a.find('div.fileText > a').attr('title')))
				fileName = a.find('div.fileText > a').text();
		}
		else
			var fileName = url.split('/')[4];
		//console.log('url: ' + url);
		//console.log('fileName: ' + fileName);

		files.push([url, fileName]);
	});

	_this.emit('parse', files);
	return;
};

/**
 * Creates the directory based on the thread id and name
 * @returns string
 */
Fourget.prototype.setAndCreateDir = function() {
	var parts = this.url.split('/');
	// when there are 7 parts the thread usually has a subject line which is slugged, we use that in our dir name
	this._dir = parts.length == 7 ?
		(this._dir = process.cwd() + path.sep + parts[3] + '_' + parts[6] + '_' + parts[5] + path.sep) :
		(this._dir = process.cwd() + path.sep + parts[3] + '_' + parts[5] + path.sep);
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
Fourget.prototype.isArchived = function(html) {
	var _this = this;

	var $ = cheerio.load(html);

	return $('.closed').length;
};

Fourget.prototype.validateThreadUrl = function() {
	return /https?:\/\/boards.4chan.org\/\S+\/thread\/\d+\/?\S*/.test(this.url);
};

/**
 * broadcastToWorkers - if an id is defined we send the payload to only that worker, otherwise it gets broadcasted to all.
 * Returns the number of messages broadcast
 * @param bool|int id
 * @param string
 * @param array|object data
 * @return int
 */
Fourget.prototype.broadcastToWorkers = function(id, cmd, data){
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
Fourget.prototype.broadcastToMaster = function(cmd, data) {
	process.send({ cmd: cmd, data: data });
};


/**
 * I like nice looking log output
 * Little log function to take advantage of ansi colours on the CL.
 * Takes as many arguments as you want, they'll be joined together to form the log string.
 * If you want to style start an argument with c: and then your colour(s) e.g.
 * this.log('c:bgGreen bold', 'This is bold text with a green background');
 */
Fourget.prototype.log = function() {
	var args = Array.prototype.slice.call(arguments);
	var msg = '';
	var skipNext = false;
	for (var i = 0; i < args.length; i++) {
		var arg = typeof args[i] == 'object' ? JSON.stringify(args[i]) : String(args[i]),
			next = typeof args[i] == 'object' ? JSON.stringify(args[i + 1]) : String(args[i + 1]);

		if (skipNext) {
			skipNext = false;
			continue;
		}

		if (arg && arg.substr(0,2) == 'c:') {
			var color = arg.substr(2, arg.length);
			color = color.split(' ');
			if (color.length == 1)
				msg += chalk[color[0]](next);
			else if (color.length == 2)
				msg += chalk[color[0]][color[1]](next);
			else if (color.length == 3)
				msg += chalk[color[0]][color[1]][color[2]](next);
			skipNext = true;
		}
		else {
			msg += arg;
			skipNext = false;
		}
	}

	var str = this.runTime() + chalk.grey('> ');
	var noAnsi = str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
	var padding = Array(12).join(' ');
	var maxLength = 12;

	console.log(str + padding.substring(0, maxLength - noAnsi.length) + msg);
};

/**
 * Returns the duration
 * @param (optional) startTime
 * @returns {string}
 */
Fourget.prototype.runTime = function(startTime) {
	var millisecondDiff = new Date().getTime() - (typeof startTime !== 'undefined' ? startTime : this._startTime);

	var elapsed = {
		'days' : 0,
		'hours' : 0,
		'mins' : 0,
		'secs' : 0,
		'ms' : millisecondDiff
	};
	if (millisecondDiff > 0) {
		elapsed.ms = millisecondDiff % 1e3;
		millisecondDiff = Math.floor( millisecondDiff / 1e3 );
		elapsed.days = Math.floor( millisecondDiff / 86400 );
		millisecondDiff %= 86400;
		elapsed.hours = Math.floor ( millisecondDiff / 3600 );
		millisecondDiff %= 3600;
		elapsed.mins = Math.floor ( millisecondDiff / 60 );
		millisecondDiff %= 60;
		elapsed.secs = Math.floor( millisecondDiff  );
	}
	var showMs = true;
	var str = '';
	if (elapsed.days > 0) {
		str += chalk.bold(elapsed.days) +'d ';
		showMs = false;
	}
	if (elapsed.hours > 0) {
		str += chalk.bold(elapsed.hours) + 'h ';
		showMs = false;
	}
	if (elapsed.mins > 0) {
		str += chalk.bold(elapsed.mins) + 'm ' ;
	}
	if (( elapsed.secs > 0 && showMs ) || ( elapsed.secs == 0 && elapsed.ms > 0 ) ) {
		str += chalk.bold(elapsed.secs) + '.' + chalk.bold(elapsed.ms) + 's';
	}
	else {
		str += chalk.bold(elapsed.secs) + 's';
	}
	return str;

};

/**
 * Outputs usage to the screen, including examples
 */
Fourget.prototype.usage = function() {
	var _this = this;
	_this.log();
	_this.log('c:bold', '4get.js ( http://github.com/jthatch/4chan-get )');
	_this.log();
	_this.log('c:bold','Usage: ./4get.js [thread] {workers} {concurrentDownloads}')
	_this.log('\t{} are optional.');
	_this.log('\t{workers} defaults to the no. of CPU cores on your machine');
	_this.log('\t{concurrentDownloads} defaults to 8');
	_this.log('Examples:');
	_this.log();
	_this.log("./4chan.js \"http://boards.4chan.org/wg/thread/6581245\"");
	_this.log("\t- Downloads a thread from wallpapers board. Media will be saved in ", "c:bold", "wg_6581245/");
	_this.log("./4chan.js \"http://boards.4chan.org/wg/thread/6581245\" 8 16");
	_this.log("\t- Supercharge your downloads across 8 cores using 16 simultaneous downloads");
	_this.log();

}


util.inherits(Fourget, EventEmitter);

// if we are being run as a command line app, execute our program
if (process.argv[1] == __filename) {
	var fourget = new Fourget();
	fourget.main();
}
else {
	module.export = new Fourget();
}

