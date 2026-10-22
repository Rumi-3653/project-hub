'use strict';
const stable=require('../lib/update-trust');
module.exports=Object.freeze({...stable,runtimeProtocol:1,
  feedUrl:'https://github.com/kieiken/project-hub/releases/latest/download/project-hub-runtime-update.json',
  windowsFeedUrl:'https://github.com/kieiken/project-hub/releases/latest/download/project-hub-runtime-update-windows.json'});
