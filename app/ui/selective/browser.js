(function () {'use strict';

const electron = require('electron');
const ipcRenderer = electron.ipcRenderer;
const handlebars = require('handlebars');
const uuid4 = require('uuid4');
const request = require('request');

const clientConfig = require('../../lib/config.js');

const logger = require('../../lib/logger.js');
const loggerFactory = require('../../lib/logger-factory.js');
const syncFactory = require('@gyselroth/balloon-node-sync');

const standardLogger = new loggerFactory(clientConfig.getAll());
logger.setLogger(standardLogger);


const i18n = require('../../lib/i18n.js');
const env = require('../../env.js');
const app = electron.remote.app;


handlebars.registerHelper('i18n', function(key) {
  var translation = i18n.__(key);

  return new handlebars.SafeString(translation);
});

$('document').ready(function() {
  $('html').addClass(process.platform);
  compileTemplates();

  ipcRenderer.send('selective-window-loaded');
  ipcRenderer.once('secret', function(event, type, secret) {
    var config = clientConfig.getAll(true);
    config[type] = secret;
    var sync = syncFactory(config, logger);

    sync.getIgnoredRemoteIds((err, ignoredRemoteIds) => {
      // TODO pixtron - handle errors
      if(err) throw err;

      logger.debug('Got ignored remote ids', {category: 'selective', ignoredRemoteIds});

      sync.blnApi.getChildren(null, {filter: {directory: true}}, (err, data) => {
        // TODO pixtron - handle errors
        if(err) throw err;

        logger.debug('Got children', {category: 'selective', data});

        var $list = $('#selective-sync').find('ul');
        $(data).each((id, node) => {
          var html = '<input type="checkbox" name="selected" value="'+node.id+'"';
          if($.inArray(node.id, ignoredRemoteIds) === -1) {
            html += ' checked';
          }

          $list.append('<li>'+html+'/><span>'+node.name+'</span></li>');
        });
      });
    });
  });

  $('#selective-apply').bind('click', function() {
    var ids = [];
    $("#selective-sync").find("input:checkbox:not(:checked)").each(function(){
      ids.push($(this).val());
    });

    logger.info('apply selective sync settings', {category: 'selective', ids});

    ipcRenderer.send('selective-apply', ids);
  });

  $('#selective-cancel').bind('click', function() {
    ipcRenderer.send('selective-close');
  });
});

function compileTemplates() {
  var templateContentHtml = $('#template-content').html();
  var $placeholderContent = $('#contentWrapper');
  var templateContent = handlebars.compile(templateContentHtml);

  var context = {};

  $placeholderContent.html(templateContent(context));
}
}());
