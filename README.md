4chan-get
================

4chan-get is a lightweight NodeJS command line tool for downloading media from 4chan.org threads. As long as the thread isn't archived (meaning no new posts will be added) the script will watch the thread and download any new media that gets posted. 4chan-get is written and maintained by [jthatch](https://github.com/jthatch).

![4get.js screenshot](http://wireside.co.uk/4get.png)

## Installation
4chan-get requires NodeJS and NPM, both of which are available via your default package manager, e.g. apt-get or yum. To install 4chan-get with a few commands, open a terminal and enter the following:
```
git clone https://github.com/jthatch/4chan-get.git  
cd 4chan-get
npm install
```

## Usage
4get.js should automatically be marked as executable, if not enter chmod +x 4get.js

`./4get.js thread`
-- To download a thread to a folder in your current working directory


## Real World Examples
Downloads a thread from the wallpapers board. Media will be saved in wg_6581245/  
`./4get.js "http://boards.4chan.org/wg/thread/6581245"`

Supercharge your downloads across 8 cores using 16 simultaneous downloads  
`./4get.js "http://boards.4chan.org/wg/thread/6581245" 8 16 `

