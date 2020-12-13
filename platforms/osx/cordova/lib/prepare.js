/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var Q = require('q');
var fs = require('fs');
var path = require('path');
var shell = require('shelljs');
var xcode = require('xcode');
var unorm = require('unorm');
var plist = require('plist');
var URL = require('url');
var events = require('cordova-common').events;
var xmlHelpers = require('cordova-common').xmlHelpers;
var ConfigParser = require('cordova-common').ConfigParser;
var CordovaError = require('cordova-common').CordovaError;
var configMunger = require('./configMunger');

/* jshint sub:true */

module.exports.prepare = function (cordovaProject) {
    var self = this;

    this._config = updateConfigFile(cordovaProject.projectConfig,
        configMunger.get(this.locations.root), this.locations);

    // Update own www dir with project's www assets and plugins' assets and js-files
    return Q.when(updateWww(cordovaProject, this.locations)).then(function () {
        // update project according to config.xml changes.
        return updateProject(self._config, self.locations);
    }).then(function () {
        handleIcons(cordovaProject.projectConfig, self.locations.xcodeCordovaProj);
    }).then(function () {
        self.events.emit('verbose', 'updated project successfully');
    });
};

/**
 * Updates config files in project based on app's config.xml and config munge,
 *   generated by plugins.
 *
 * @param   {ConfigParser}   sourceConfig  A project's configuration that will
 *   be merged into platform's config.xml
 * @param   {ConfigChanges}  configMunger  An initialized ConfigChanges instance
 *   for this platform.
 * @param   {Object}         locations     A map of locations for this platform
 *
 * @return  {ConfigParser}                 An instance of ConfigParser, that
 *   represents current project's configuration. When returned, the
 *   configuration is already dumped to appropriate config.xml file.
 */
function updateConfigFile (sourceConfig, configMunger, locations) {
    events.emit('verbose', 'Generating config.xml from defaults for platform "osx"');

    // First cleanup current config and merge project's one into own
    // Overwrite platform config.xml with defaults.xml.
    shell.cp('-f', locations.defaultConfigXml, locations.configXml);

    // Then apply config changes from global munge to all config files
    // in project (including project's config)
    configMunger.reapply_global_munge().save_all();

    // Merge changes from app's config.xml into platform's one
    var config = new ConfigParser(locations.configXml);
    xmlHelpers.mergeXml(sourceConfig.doc.getroot(),
        config.doc.getroot(), 'osx', /* clobber= */true);

    config.write();
    return config;
}

/**
 * Updates platform 'www' directory by replacing it with contents of
 *   'platform_www' and app www. Also copies project's overrides' folder into
 *   the platform 'www' folder
 *
 * @param   {Object}  cordovaProject    An object which describes cordova project.
 * @param   {Object}  destinations      An object that contains destination
 *   paths for www files.
 */
function updateWww (cordovaProject, destinations) {
    shell.rm('-rf', destinations.www);
    shell.mkdir('-p', destinations.www);
    // Copy source files from project's www directory
    shell.cp('-rf', path.join(cordovaProject.locations.www, '*'), destinations.www);
    // Override www sources by files in 'platform_www' directory
    shell.cp('-rf', path.join(destinations.platformWww, '*'), destinations.www);

    // If project contains 'merges' for our platform, use them as another overrides
    var merges_path = path.join(cordovaProject.root, 'merges', 'osx');
    if (fs.existsSync(merges_path)) {
        events.emit('verbose', 'Found "merges" for osx platform. Copying over existing "www" files.');
        var overrides = path.join(merges_path, '*');
        shell.cp('-rf', overrides, destinations.www);
    }
}

/**
 * Updates project structure and AndroidManifest according to project's configuration.
 *
 * @param   {ConfigParser}  platformConfig  A project's configuration that will
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform (In/Out)
 */
function updateProject (platformConfig, locations) {
    // CB-6992 it is necessary to normalize characters
    // because node and shell scripts handles unicode symbols differently
    // We need to normalize the name to NFD form since OSX uses NFD unicode form
    var name = unorm.nfd(platformConfig.name());
    var pkg = platformConfig.ios_CFBundleIdentifier() || platformConfig.packageName();
    var version = platformConfig.version();

    var originalName = path.basename(locations.xcodeCordovaProj);

    // Update package id (bundle id)
    var plistFile = path.join(locations.xcodeCordovaProj, originalName + '-Info.plist');
    var infoPlist = plist.parse(fs.readFileSync(plistFile, 'utf8'));
    infoPlist.CFBundleIdentifier = pkg;

    // Update version (bundle version)
    infoPlist.CFBundleShortVersionString = version;
    var CFBundleVersion = platformConfig.ios_CFBundleVersion() || default_CFBundleVersion(version);
    infoPlist.CFBundleVersion = CFBundleVersion;

    // Update Author if present
    var author = platformConfig.author();
    var copyRight = infoPlist.NSHumanReadableCopyright;
    if (copyRight && author) {
        infoPlist.NSHumanReadableCopyright = copyRight.replace('--AUTHOR--', author);
    }

    // replace Info.plist ATS entries according to <access> and <allow-navigation> config.xml entries
    var ats = writeATSEntries(platformConfig);
    if (Object.keys(ats).length > 0) {
        infoPlist.NSAppTransportSecurity = ats;
    } else {
        delete infoPlist.NSAppTransportSecurity;
    }

    var info_contents = plist.build(infoPlist);
    info_contents = info_contents.replace(/<string>[\s\r\n]*<\/string>/g, '<string></string>');
    fs.writeFileSync(plistFile, info_contents, 'utf-8');
    events.emit('verbose', 'Wrote out OSX Bundle Identifier to "' + pkg + '"');
    events.emit('verbose', 'Wrote out OSX Bundle Version to "' + version + '"');

    return handleBuildSettings(platformConfig, locations).then(function () {
        if (name === originalName) {
            events.emit('verbose', 'OSX Product Name has not changed (still "' + originalName + '")');
            return Q();
        }

        // Update product name inside pbxproj file
        var proj = new xcode.project(locations.pbxproj); // eslint-disable-line
        try {
            proj.parseSync();
        } catch (err) {
            return Q.reject(new CordovaError('An error occurred during parsing of project.pbxproj. Start weeping. Output: ' + err));
        }

        proj.updateProductName(name);
        fs.writeFileSync(locations.pbxproj, proj.writeSync(), 'utf-8');

        // Move the xcodeproj and other name-based dirs over.
        shell.mv(path.join(locations.xcodeCordovaProj, originalName + '-Info.plist'), path.join(locations.xcodeCordovaProj, name + '-Info.plist'));
        shell.mv(path.join(locations.xcodeCordovaProj, originalName + '-Prefix.pch'), path.join(locations.xcodeCordovaProj, name + '-Prefix.pch'));
        // CB-8914 remove userdata otherwise project is un-usable in xcode
        shell.rm('-rf', path.join(locations.xcodeProjDir, 'xcuserdata/'));
        shell.mv(locations.xcodeProjDir, path.join(locations.root, name + '.xcodeproj'));
        shell.mv(locations.xcodeCordovaProj, path.join(locations.root, name));

        // Update locations with new paths
        locations.xcodeCordovaProj = path.join(locations.root, name);
        locations.xcodeProjDir = path.join(locations.root, name + '.xcodeproj');
        locations.pbxproj = path.join(locations.xcodeProjDir, 'project.pbxproj');

        // Hack this shi*t
        var pbx_contents = fs.readFileSync(locations.pbxproj, 'utf-8');
        pbx_contents = pbx_contents.split(originalName).join(name);
        fs.writeFileSync(locations.pbxproj, pbx_contents, 'utf-8');
        events.emit('verbose', 'Wrote out OSX Product Name and updated XCode project file names from "' + originalName + '" to "' + name + '".');
        // in case of updated paths we return them back to
        return Q();
    });
}

function handleBuildSettings (platformConfig, locations) {
    // nothing to do
    return Q();
}

function handleIcons (projectConfig, platformRoot) {
    // Update icons
    var icons = projectConfig.getIcons('osx');
    var appRoot = path.dirname(projectConfig.path);

    // See https://developer.apple.com/library/mac/documentation/UserExperience/Conceptual/OSXHIGuidelines/Designing.html
    // for application images sizes reference.
    var platformIcons = [
        { dest: 'icon-1024x1024.png', width: 1024, height: 1024 },
        { dest: 'icon-512x512.png', width: 512, height: 512 },
        { dest: 'icon-256x256.png', width: 256, height: 256 },
        { dest: 'icon-128x128.png', width: 128, height: 128 },
        { dest: 'icon-64x64.png', width: 64, height: 64 },
        { dest: 'icon-32x32.png', width: 32, height: 32 },
        { dest: 'icon-16x16.png', width: 16, height: 16 }
    ];

    platformIcons.forEach(function (item) {
        var icon = icons.getBySize(item.width, item.height) || icons.getDefault();
        if (icon) {
            var src = path.join(appRoot, icon.src);
            var dst = path.join(platformRoot, 'Images.xcassets/AppIcon.appiconset/', item.dest);
            events.emit('verbose', 'Copying icon from ' + src + ' to ' + dst);
            shell.cp('-f', src, dst);
        }
    });
}

/*
    Parses all <access> and <allow-navigation> entries and consolidates duplicates (for ATS).
    Returns an object with a Hostname as the key, and the value an object with properties:
        {
            Hostname, // String
            NSExceptionAllowsInsecureHTTPLoads, // boolean
            NSIncludesSubdomains,  // boolean
            NSExceptionMinimumTLSVersion, // String
             NSExceptionRequiresForwardSecrecy // boolean
        }
*/
function processAccessAndAllowNavigationEntries (config) {
    var accesses = config.getAccesses();
    var allow_navigations = config.getAllowNavigations();

    // we concat allow_navigations and accesses, after processing accesses
    return allow_navigations.concat(accesses.map(function (obj) {
        // map accesses to a common key interface using 'href', not origin
        obj.href = obj.origin;
        delete obj.origin;
        return obj;
    // we reduce the array to an object with all the entries processed (key is Hostname)
    })).reduce(function (previousReturn, currentElement) {
        var obj = parseWhitelistUrlForATS(currentElement.href, currentElement.minimum_tls_version, currentElement.requires_forward_secrecy);
        if (obj) {
            // we 'union' duplicate entries
            var item = previousReturn[obj.Hostname];
            if (!item) {
                item = {};
            }
            for (var o in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, o)) {
                    item[o] = obj[o];
                }
            }
            previousReturn[obj.Hostname] = item;
        }
        return previousReturn;
    }, {});
}

/*
    Parses a URL and returns an object with these keys:
        {
            Hostname, // String
            NSExceptionAllowsInsecureHTTPLoads, // boolean (default: false)
            NSIncludesSubdomains,  // boolean (default: false)
            NSExceptionMinimumTLSVersion, // String (default: 'TLSv1.2')
            NSExceptionRequiresForwardSecrecy // boolean (default: true)
        }

    null is returned if the URL cannot be parsed, or is to be skipped for ATS.
*/
function parseWhitelistUrlForATS (url, minimum_tls_version, requires_forward_secrecy) {
    // @todo 'url.parse' was deprecated since v11.0.0. Use 'url.URL' constructor instead  node/no-deprecated-api
    var href = URL.parse(url); // eslint-disable-line
    var retObj = {};
    retObj.Hostname = href.hostname;

    if (url === '*') {
        return {
            Hostname: '*'
        };
    }

    // Guiding principle: we only set values in retObj if they are NOT the default

    if (!retObj.Hostname) {
        // check origin, if it allows subdomains (wildcard in hostname), we set NSIncludesSubdomains to YES. Default is NO
        var subdomain1 = '/*.'; // wildcard in hostname
        var subdomain2 = '*://*.'; // wildcard in hostname and protocol
        var subdomain3 = '*://'; // wildcard in protocol only
        if (href.pathname.indexOf(subdomain1) === 0) {
            retObj.NSIncludesSubdomains = true;
            retObj.Hostname = href.pathname.substring(subdomain1.length);
        } else if (href.pathname.indexOf(subdomain2) === 0) {
            retObj.NSIncludesSubdomains = true;
            retObj.Hostname = href.pathname.substring(subdomain2.length);
        } else if (href.pathname.indexOf(subdomain3) === 0) {
            retObj.Hostname = href.pathname.substring(subdomain3.length);
        } else {
            // Handling "scheme:*" case to avoid creating of a blank key in NSExceptionDomains.
            return null;
        }
    }

    if (minimum_tls_version && minimum_tls_version !== 'TLSv1.2') { // default is TLSv1.2
        retObj.NSExceptionMinimumTLSVersion = minimum_tls_version;
    }

    var rfs = (requires_forward_secrecy === 'true');
    if (requires_forward_secrecy && !rfs) { // default is true
        retObj.NSExceptionRequiresForwardSecrecy = false;
    }

    // if the scheme is HTTP, we set NSExceptionAllowsInsecureHTTPLoads to YES. Default is NO
    if (href.protocol === 'http:') {
        retObj.NSExceptionAllowsInsecureHTTPLoads = true;
    } else if (!href.protocol && href.pathname.indexOf('*:/') === 0) { // wilcard in protocol
        retObj.NSExceptionAllowsInsecureHTTPLoads = true;
    }

    return retObj;
}

/*
    App Transport Security (ATS) writer from <access> and <allow-navigation> tags
    in config.xml
*/
function writeATSEntries (config) {
    var pObj = processAccessAndAllowNavigationEntries(config);

    var ats = {};

    for (var hostname in pObj) {
        if (Object.prototype.hasOwnProperty.call(pObj, hostname)) {
            if (hostname === '*') {
                ats.NSAllowsArbitraryLoads = true;
                continue;
            }

            var entry = pObj[hostname];
            var exceptionDomain = {};

            for (var key in entry) {
                if (Object.prototype.hasOwnProperty.call(entry, key) && key !== 'Hostname') {
                    exceptionDomain[key] = entry[key];
                }
            }

            if (!ats.NSExceptionDomains) {
                ats.NSExceptionDomains = {};
            }

            ats.NSExceptionDomains[hostname] = exceptionDomain;
        }
    }

    return ats;
}

// Construct a default value for CFBundleVersion as the version with any
// -rclabel stripped=.
function default_CFBundleVersion (version) {
    return version.split('-')[0];
}
