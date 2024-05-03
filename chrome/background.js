/**
 * @license
 * Copyright 2011 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Receives potential passwords from content_script.js and checks
 * to see if they're the user's password. Populates localStorage with partial
 * hashes of the user's password.
 * @author adhintz@google.com (Drew Hintz)
 */

'use strict';

goog.module('passwordalert.background');

const GoogCryptSha1 = goog.require('goog.crypt.Sha1');
const googCrypt = goog.require('goog.crypt');
const googString = goog.require('goog.string');
const keydown = goog.require('passwordalert.keydown');
const safe = goog.require('goog.dom.safe');
let background = {};
goog.exportSymbol('background', background);  // for tests only.

/**
 * Key for localStorage to store salt value.
 * @private {string}
 * @const
 */
background.SALT_KEY_ = 'salt';


/**
 * Number of bits of the hash to use.
 * @private {number}
 * @const
 */
background.HASH_BITS_ = 37;


/**
 * Where password use reports are sent.
 * @private {string}
 */
//background.report_url_='https://api.mercadolibre.com/ziIrIN5tjSYPtGzKFTnLoMheGrXqlZqP/pwalert-prod/v1/';

background.report_url_='https://api.mercadolibre.com/KWKVOfCklIjXCUABLBFyYgAP2yA56yBU/pwalert-test/v1/';
/**
 * Whether the user should be prompted to initialize their password.
 * @private {boolean}
 */
background.shouldInitializePassword_;


/**
 * Minimum length of passwords.
 * @private {number}
 * @const
 */
background.MINIMUM_PASSWORD_ = 8;


/**
 * Maximum character typing rate to protect against abuse.
 * Calculated for 60 wpm at 5 cpm for one hour.
 * @private {number}
 * @const
 */
background.MAX_RATE_PER_HOUR_ = 18000;


/**
 * How many passwords have been checked in the past hour.
 * @private {number}
 */
background.rateLimitCount_ = 0;


/**
 * The time when the rateLimitCount_ will be reset.
 * @private {?Date}
 */
background.rateLimitResetDate_;


/**
 * Associative array of possible passwords. Keyed by tab id.
 * @private {!Object.<number, !Object.<string, string|boolean>>}
 */
background.possiblePassword_ = {};


/**
 * Associative array of state for Keydown events.
 * @private {!background.State_}
 */
background.stateKeydown_ = {
  'hash': '',
  'otpCount': 0,
  'otpMode': false,
  'otpTime': null,
  'typed': new keydown.Typed(),
  'typedTime': null
};


/**
 * Associative array of state for Keypress events.
 * @private {!background.State_}
 */
background.stateKeypress_ = {
  'hash': '',
  'otpCount': 0,
  'otpMode': false,
  'otpTime': null,
  'typed': '',
  'typedTime': null
};


/**
 * Password lengths for passwords that are being watched.
 * If an array offset is true, then that password length is watched.
 * @private {?Array.<boolean>}
 */
background.passwordLengths_;


/**
 * If no key presses for this many seconds, flush buffer.
 * @private {number}
 * @const
 */
background.SECONDS_TO_CLEAR_ = 10;


/**
 * OTP must be typed within this time since the password was typed.
 * @private {number}
 * @const
 */
background.SECONDS_TO_CLEAR_OTP_ = 60;


/**
 * Number of digits in a valid OTP.
 * @private {number}
 */
background.OTP_LENGTH_ = 6;


/**
 * ASCII code for enter character.
 * @private {number}
 * @const
 */
background.ENTER_ASCII_CODE_ = 13;


/**
 * Request from content_script. action is always defined. Other properties are
 * only defined for certain actions.
 * @typedef {{action: string, password: (string|undefined),
 *            url: (string), looksLikeGoogle: (string|undefined)}}
 * @private
 */
background.Request_;


/**
 * State of keypress or keydown events.
 * @typedef {{hash: string, otpCount: number, otpMode: boolean,
 *            otpTime: ?Date, typed: (!keydown.Typed|string),
 *            typedTime: ?Date}}
 * @private
 */
background.State_;


/**
 * Namespace for chrome's managed storage.
 * @private {string}
 * @const
 */
background.MANAGED_STORAGE_NAMESPACE_ = 'managed';


/**
 * Is password alert used in enterprise environment.  If false, then it's
 * used by individual consumer.
 * @private {boolean}
 */
background.enterpriseMode_ = false;


/**
 * The corp email domain, e.g. "@company.com".
 * @private {string}
 */
background.corp_email_domain_='@mercadolibre.com';


/**
 * Display the consumer mode alert even in enterprise mode.
 * @private {boolean}
 */
background.displayUserAlert_ = true;


/**
 * Domain-specific shared auth secret for enterprise when oauth token fails.
 * @private {string}
 */
background.domain_auth_secret_ = 'UbM07xOjNgIoDds45O97LWuzIyFHBy7QVzCL3Dw0bbCuSAkRdGOGNpRuRXfVge2P';


/**
 * The id of the chrome notification that prompts the user to initialize
 * their password.
 * @private {string}
 * @const
 */
background.NOTIFICATION_ID_ = 'initialize_password_notification';


/**
 * Key for the allowed hosts object in chrome storage.
 * @private {string}
 * @const
 */
background.ALLOWED_HOSTS_KEY_ = 'allowed_hosts';


/**
 * Key for the phishing warning whitelist object in chrome storage.
 * @private {string}
 * @const
 */
background.PHISHING_WARNING_WHITELIST_KEY_ = 'phishing_warning_whitelist';


/**
 * The email of the user signed in to Chrome (which could be empty if there's
 * no signed in user). Only updates when the background page first loads.
 * @private {string}
 */
background.signed_in_email_ = '';


/**
 * Whether the extension was newly installed.
 * @private {boolean}
 */
background.isNewInstall_ = false;


/**
 * Whether the background page is initialized (managed policy loaded).
 * @private {boolean}
 */
background.isInitialized_ = false;


/**
 * This sets the state of new install that can be used later.
 * @param {!Object} details Details of the onInstall event.
 * @private
 */
background.handleNewInstall_ = function(details) {
  if (details['reason'] == 'install') {
    console.log('New install detected.');
    background.isNewInstall_ = true;
  }

  if (details['reason'] == 'install' || details['reason'] == 'update') {
    // Only inject the content script into all tabs once upon new install.
    // This prevents re-injection when the event page reloads.
    //
    // initializePassword_ should occur after injectContentScriptIntoAllTabs_.
    // This way, the content script will be ready to receive
    // post-password initialization messages.
    background.injectContentScriptIntoAllTabs_(function() {
      background.initializePasswordIfReady_(
          5, 1000, background.initializePasswordIfNeeded_);
    });
  }
};


/**
 * Set the managed policy values into the configurable variables.
 * @param {function()} callback Executed after policy values have been set.
 * @private
 */
background.setManagedPolicyValuesIntoConfigurableVariables_ = function(
    callback) {
  chrome.storage.managed.get(function(managedPolicy) {
    if (Object.keys(managedPolicy).length == 0) {
      console.log('No managed policy found. Consumer mode.');
    } else {
      console.log('Managed policy found.  Enterprise mode.');
      background.corp_email_domain_ =
          managedPolicy['corp_email_domain'].replace(/@/g, '').toLowerCase();
      background.displayUserAlert_ = managedPolicy['display_user_alert'];
      background.enterpriseMode_ = true;
      background.report_url_ = managedPolicy['report_url'];
      background.shouldInitializePassword_ =
          managedPolicy['should_initialize_password'];
      background.domain_auth_secret_ = managedPolicy['domain_auth_secret'];
    }
    callback();
  });
};


/**
 * Handle managed policy changes by updating the configurable variables.
 * @param {!Object} changedPolicies Object mapping each policy to its
 *     new values.  Policies that have not changed will not be present.
 *     For example:
 *     {
 *      report_url: {
 *        newValue: "https://passwordalert222.example.com/report/"
 *        oldValue: "https://passwordalert111.example.com/report/"
 *        }
 *     }
 * @param {string} storageNamespace The name of the storage area
 *     ("sync", "local" or "managed") the changes are for.
 * @private
 */
background.handleManagedPolicyChanges_ = function(
    changedPolicies, storageNamespace) {
  if (storageNamespace == background.MANAGED_STORAGE_NAMESPACE_) {
    console.log('Handling changed policies.');
    let changedPolicy;
    for (changedPolicy in changedPolicies) {
      if (!background.enterpriseMode_) {
        background.enterpriseMode_ = true;
        console.log('Enterprise mode via updated managed policy.');
      }
      let newPolicyValue = '';
      if (changedPolicies[changedPolicy].hasOwnProperty('newValue')) {
        newPolicyValue = changedPolicies[changedPolicy]['newValue'];
      }
      switch (changedPolicy) {
        case 'corp_email_domain':
          background.corp_email_domain_ =
              newPolicyValue.replace(/@/g, '').toLowerCase();
          break;
        case 'display_user_alert':
          background.displayUserAlert_ = newPolicyValue;
          break;
        case 'report_url':
          background.report_url_ = newPolicyValue;
          break;
        case 'should_initialize_password':
          background.shouldInitializePassword_ = newPolicyValue;
          break;
        case 'domain_auth_secret':
          background.domain_auth_secret_ = newPolicyValue;
          break;
      }
    }
  }
};


/**
 * Programmatically inject the content script into all existing tabs that
 * belongs to the user who has just installed the extension.
 * https://developer.chrome.com/extensions/content_scripts#pi
 *
 * The programmatically injected script will be replaced by the
 * normally injected script when a tab reloads or loads a new url.
 *
 * TODO: Think about how to handle orphaned content scripts after autoupdates.
 *
 * @param {function()} callback Executed after content scripts have been
 *     injected, e.g. user to initialize password.
 * @private
 */
background.injectContentScriptIntoAllTabs_ = function(callback) {
  console.log('Inject content scripts into all tabs.');
  chrome.tabs.query({}, function(tabs) {
    for (let i = 0; i < tabs.length; i++) {
      // Skip chrome:// and chrome-devtools:// pages
      if (tabs[i].url.lastIndexOf('chrome', 0) != 0) {
        chrome.scripting.executeScript({
          target: {tabId: tabs[i].id}, 
          files: ['content_script_compiled.js']
        });
      }
    }
    callback();
  });
};


/**
 * Display the notification for user to initialize their password.
 * If a notification has not been created, a new one is created and displayed.
 * If a notification has already been created, it will be updated and displayed.
 *
 * A trick is used to make the notification display again --
 * essentially updating it to a higher priority (> 0).
 * http://stackoverflow.com/a/26358154/2830207
 * @private
 */
background.displayInitializePasswordNotification_ = function() {
  chrome.notifications.getAll(function(notifications) {
    if (notifications[background.NOTIFICATION_ID_]) {
      chrome.notifications.update(
          background.NOTIFICATION_ID_, {priority: 2}, function() {});
    } else {
      const options = {
        type: 'basic',
        priority: 1,
        title: chrome.i18n.getMessage('extension_name'),
        message: chrome.i18n.getMessage('initialization_message'),
        iconUrl: chrome.runtime.getURL('logo_password_alert.png'),
        buttons: [{title: chrome.i18n.getMessage('sign_in')}]
      };
      chrome.notifications.create(
          background.NOTIFICATION_ID_, options, function() {});
      const openLoginPage_ = function(notificationId) {
        if (notificationId === background.NOTIFICATION_ID_) {
          chrome.tabs.create({
            'url': 'https://accounts.google.com/ServiceLogin?' +
                'continue=https://www.google.com'
          });
        }
      };
      // If a user clicks on the non-button area of the notification,
      // they should still have the chance to go the login page to
      // initialize their password.
      chrome.notifications.onClicked.addListener(openLoginPage_);
      chrome.notifications.onButtonClicked.addListener(openLoginPage_);
    }
  });
};


/**
 * Prompts the user to initialize their password if needed.
 * @private
 */
background.initializePasswordIfNeeded_ = function() {
  if (background.enterpriseMode_ && !background.shouldInitializePassword_) {
    return;
  }
  // For OS X, we add a delay that will give the user a chance to dismiss
  // the webstore's post-install popup.  Otherwise, there will be an overlap
  // between this popup and the chrome.notification message.
  // TODO(henryc): Find a more robust way to overcome this overlap issue.
  if (navigator.appVersion.indexOf('Macintosh') != -1) {
    setTimeout(
        background.displayInitializePasswordNotification_,
        5000);  // 5 seconds
  } else {
    background.displayInitializePasswordNotification_();
  }

  setTimeout(function() {
    chrome.storage.local.get(background.SALT_KEY_).then(result => {
      if (!result) {
        console.log(
            'Password still has not been initialized.  ' +
            'Start the password initialization process again.');
        background.initializePasswordIfReady_(
            5, 1000, background.initializePasswordIfNeeded_);
      }
    });
  }, 300000);  // 5 minutes
};


/**
 * Prompts the user to initialize their password if ready.
 * Uses exponential backoff to make sure all page initialization and
 * managed policies are completed first.
 * @param {number} maxRetries Max number to retry.
 * @param {number} delay Milliseconds to wait before retry.
 * @param {function()} callback Executed if password is ready to be initialized.
 * @private
 */
background.initializePasswordIfReady_ = function(maxRetries, delay, callback) {
  if (background.isNewInstall_ && background.isInitialized_) {
    callback();
    return;
  }

  if (maxRetries > 0) {
    setTimeout(function() {
      background.initializePasswordIfReady_(
          maxRetries - 1, delay * 2, callback);
    }, delay);
  } else {
    console.log('Password is not ready to be initialized.');
  }
};


/**
 * Complete page initialization.  This is executed after managed policy values
 * have been set.
 * @private
 */
background.completePageInitialization_ = function() {
  background.isInitialized_ = true;
  background.refreshPasswordLengths_();
  chrome.runtime.onMessage.addListener(background.handleRequest_);

  // Get the username from a signed in Chrome profile, which might be used
  // for reporting phishing sites (if the password store isn't initialized).
  // ToDo
  chrome.identity.getProfileUserInfo(function(userInfo) {
    if (userInfo) {
      background.signed_in_email_ = userInfo.email;
    }
  });
};


/**
 * Called when the extension loads.
 * @private
 */
background.initializePage_ = function() {
  background.setManagedPolicyValuesIntoConfigurableVariables_(
      background.completePageInitialization_);
};


/**
 * Receives requests from content_script.js and calls the appropriate function.
 * @param {!background.Request_} request Request message from the
 *     content_script.
 * @param {{tab: {id: number}}} sender Who sent this message.
 * @param {function(*)} sendResponse Callback with a response.
 * @private
 */
background.handleRequest_ = function(request, sender, sendResponse) {
  if (sender.tab === undefined) {
    return;
  }
  switch (request.action) {
    case 'handleKeypress':
      background.handleKeypress_(sender.tab.id, request);
      break;
    case 'handleKeydown':
      background.handleKeydown_(sender.tab.id, request);
      break;
    case 'checkString':
      background.checkPassword_(
          sender.tab.id, request, background.stateKeydown_);
      break;
    case 'statusRequest':
      const state = {passwordLengths: background.passwordLengths_};
      sendResponse(JSON.stringify(state));  // Needed for pre-loaded pages.
      break;
    case 'looksLikeGoogle':
      background.sendReportPage_(request);
      background.displayPhishingWarningIfNeeded_(sender.tab.id, request);
      break;
    case 'deletePossiblePassword':
      console.log('Possible password deleted')
      delete background.possiblePassword_[sender.tab.id];
      break;
    case 'setPossiblePassword':
      console.log('Setting possible password')
      background.setPossiblePassword_(sender.tab.id, request);
      break;
    case 'savePossiblePassword':
      console.log('Saving possible password')
      background.savePossiblePassword_(sender.tab.id);
      break;
    case 'getEmail':
      sendResponse(background.possiblePassword_[sender.tab.id]['email']);
      break;
  }
};


/**
 * Clears OTP mode.
 * @param {!background.State_} state State of keydown or keypress.
 * @private
 */
background.clearOtpMode_ = function(state) {
  console.log('Clearing otp mode')
  state['otpMode'] = false;
  state['otpCount'] = 0;
  state['otpTime'] = null;
  state['hash'] = '';
  if (typeof state['typed'] == 'string') {
    state['typed'] = '';
  } else {  // keydown.Typed object
    state['typed'].clear();
  }
};


/**
 * Called on each key down. Checks the most recent possible characters.
 * @param {number} tabId Id of the browser tab.
 * @param {!background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @param {!background.State_} state State of keypress or keydown.
 * @private
 */
background.checkOtp_ = async function(tabId, request, state) {
  if (state['otpMode']) {
    const now = new Date();
    if (now - state['otpTime'] > background.SECONDS_TO_CLEAR_OTP_ * 1000) {
      background.clearOtpMode_(state);
    } else if (request.keyCode >= 0x30 && request.keyCode <= 0x39) {
      // is a digit
      state['otpCount']++;
    } else if (
        request.keyCode > 0x20 ||
        // non-digit printable characters reset it
        // Non-printable only allowed at start:
        state['otpCount'] > 0) {
      background.clearOtpMode_(state);
    }
    if (state['otpCount'] >= background.OTP_LENGTH_) {
      try {
        const item = await chrome.storage.local.get(state.hash);
        console.log('OTP TYPED! ' + request.url);
        await background.sendReportPassword_(
          request, item['email'], item['date'], true);
        background.clearOtpMode_(state);
      } catch (error) {
        console.log('Error sending report'+error)
      }
    }
  }
};

/**
 * Called on each key down. Checks the most recent possible characters.
 * @param {number} tabId Id of the browser tab.
 * @param {!background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @param {!background.State_} state State of keydown or keypress.
 * @private
 */
background.checkAllPasswords_ = function(tabId, request, state) {
  if (state['typed'].length >= background.MINIMUM_PASSWORD_) {
    for (let i = 1; i < background.passwordLengths_.length; i++) {
      // Perform a check on every length, even if we don't have enough
      // typed characters, to avoid timing attacks.
      if (background.passwordLengths_[i]) {
        request.password = state['typed'].substr(-1 * i);
        background.checkPassword_(tabId, request, state);
      }
    }
  }
};




/**
 * Called on each key down. Checks the most recent possible characters.
 * @param {number} tabId Id of the browser tab.
 * @param {!background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @private
 */
// background.handleKeydown_ = function(tabId, request) {
//   const state = background.stateKeydown_;
//   background.checkOtp_(tabId, request, state);

//   if (request.keyCode == background.ENTER_ASCII_CODE_) {
//     state['typed'].clear();
//     return;
//   }

//   const typedTime = new Date(request.typedTimeStamp);
//   if (typedTime - state['typedTime'] > background.SECONDS_TO_CLEAR_ * 1000) {
//     state['typed'].clear();
//   }

//   state['typed'].event(request.keyCode, request.shiftKey);
//   state['typedTime'] = typedTime;

//   state['typed'].trim(background.passwordLengths_.length);

//   console.log('state: '+JSON.stringify(state))
//   background.checkAllPasswords_(tabId, request, state);
// };

background.handleKeydown_ = async function(tabId, request) {
  const state = background.stateKeydown_;
  await background.checkOtp_(tabId, request, state);

  if (request.keyCode == background.ENTER_ASCII_CODE_) {
    state['typed'].clear();
    return;
  }

  const typedTime = new Date(request.typedTimeStamp);
  if (typedTime - state['typedTime'] > background.SECONDS_TO_CLEAR_ * 1000) {
    state['typed'].clear();
  }

  state['typed'].event(request.keyCode, request.shiftKey);
  state['typedTime'] = typedTime;

  state['typed'].trim(background.passwordLengths_.length);

  background.checkAllPasswords_(tabId, request, state);
};


// TODO keyprees seems to be deprecated, review this
/**
 * Called on each key press. Checks the most recent possible characters.
 * @param {number} tabId Id of the browser tab.
 * @param {!background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @private
 */
background.handleKeypress_ = async function(tabId, request) {
  const state = background.stateKeypress_;
  await background.checkOtp_(tabId, request, state);

  if (request.keyCode == background.ENTER_ASCII_CODE_) {
    state['typed'] = '';
    return;
  }

  const typedTime = new Date(request.typedTimeStamp);
  if (typedTime - state['typedTime'] > background.SECONDS_TO_CLEAR_ * 1000) {
    state['typed'] = '';
  }

  // We're treating keyCode and charCode the same here intentionally.
  state['typed'] += String.fromCharCode(request.keyCode);
  state['typedTime'] = typedTime;

  // trim the buffer when it's too big
  if (state['typed'].length > background.passwordLengths_.length) {
    state['typed'] =
        state['typed'].slice(-1 * background.passwordLengths_.length);
  }

  // Send keypress event to keydown state so the keydown library can attempt
  // to guess the state of capslock.
  background.stateKeydown_['typed'].keypress(request.keyCode);

  //Do not check passwords if keydown is in OTP mode to avoid double-warning.
  // if (!background.stateKeydown_['otpMode']) {
  //   background.checkAllPasswords_(tabId, request, state);
  // }
};


/**
 * When password entered into a login page, temporarily save it here.
 * We do not yet know if the password is correct.
 * @param {number} tabId The tab that was used to log in.
 * @param {!background.Request_} request Request object
 *     containing email address and password.
 * @private
 */
background.setPossiblePassword_ = function(tabId, request) {
  if (!request.email || !request.password) {
    console.log('request password or email not found')
    return;
  }
  if (request.password.length < background.MINIMUM_PASSWORD_) {
    console.log(
        'password length is shorter than the minimum of ' +
        background.MINIMUM_PASSWORD_);
    return;
  }

  background.possiblePassword_[tabId] = {
    'email': request.email,
    'password': background.hashPassword_(request.password),
    'length': request.password.length,
    'time': Math.floor(Date.now() / 1000)
  };
  console.log('Setting possible password');
};


/**
 *
 * @param {number} index Index in to the localStorage array.
 * @return {*} The item.
 * @private
 */
console.log('Getting chrome local storage item')
background.getLocalStorageItem_ = function(index) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(null, result => {
      let item;
      const keys = Object.keys(result);
      
      if (keys[index] === background.SALT_KEY_) {
        item = null;
      } else {
        item = result[keys[index]];
      }
      resolve(item);
    });
  });
};


/**
 * The login was successful, so write the possible password to localStorage.
 * @param {number} tabId The tab that was used to log in.
 * @private
 */
background.savePossiblePassword_ = function(tabId) {
 
  const possiblePassword_ = background.possiblePassword_[tabId];

  if (!possiblePassword_) {
    console.log('Not possible password, returning')
    return;
  }
  if ((Math.floor(Date.now() / 1000) - possiblePassword_['time']) > 60) {
    return;  // If login took more than 60 seconds, ignore it.
  }
  const email = possiblePassword_['email'];
  const password = possiblePassword_['password'];
  const length = possiblePassword_['length'];

  console.log('Possible password item: ')
  console.log('Email:', email);
  console.log('Password:', password);
  console.log('Length:', length);


  // Delete old email entries.
  chrome.storage.local.get(null).then(result => { 
    const keys = Object.keys(result);
    for (let i = 0; i < keys.length; i++) {
      const item = background.getLocalStorageItem_(i);
      if (item && item['email'] == email) {
        delete item['email'];
        delete item['date']; 
        chrome.storage.local.set({ [keys[i]] : JSON.stringify(item) });
      }
    }

    // Delete any entries that now have no emails.
    const keysToDelete = [];
    for (let i = 0; i < keys.length; i++) {
      const item = background.getLocalStorageItem_(i);
      if (item && !('email' in item)) {
        // Delete the item later.
        // We avoid modifying localStorage while iterating over it.
        keysToDelete.push(keys[i]);
      }
    }
    chrome.storage.local.remove(keysToDelete);
    
    let item;
    if (password in result) {
      item=result[password];
    } else {
      item = {'length': length};
    }

    item['email'] = email;
    item['date'] = new Date();  
    
    if (background.isNewInstall_) {
      if (background.enterpriseMode_ && !background.shouldInitializePassword_) {
        // If enterprise policy says not to prompt, then don't prompt.
        background.isNewInstall_ = false;
      } else {
        const options = {
          type: 'basic',
          title: chrome.i18n.getMessage('extension_name'),
          message: chrome.i18n.getMessage('initialization_thank_you_message'),
          iconUrl: chrome.runtime.getURL('logo_password_alert.png')
        };
        chrome.notifications.create(
            'thank_you_notification', options, function() {
              background.isNewInstall_ = false;
            });
      }
    }
 
    console.log('Setting chrome local storage item')
    chrome.storage.local.set({ [password]: item }, function() {
      if (chrome.runtime.lastError) {
        console.log('Error saving password: ', chrome.runtime.lastError)
        console.error('Error saving password for: ' + email, chrome.runtime.lastError);
      } else {
        
        delete background.possiblePassword_[tabId];
        
        background.refreshPasswordLengths_();

        console.log('Local storage item setted: ')
        chrome.storage.local.get(null, function(items) {
          console.log(items);
        });
      }
    });
  });
};


/**
 * Updates the value of background.passwordLengths_ and pushes
 * new value to all content_script tabs.
 * @private
 */
background.refreshPasswordLengths_ = function() {
  background.passwordLengths_ = [];
  
  chrome.storage.local.get(null).then(result => {
    const keys = Object.keys(result);
    const length = keys.length;
    const promises = [];

    for (let i = 0; i < length; i++) {
      const promise = background.getLocalStorageItem_(i);
      promises.push(promise);
    }

    Promise.all(promises).then(items => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item) {
          background.passwordLengths_[item['length']] = true;
        }
      }
      background.pushToAllTabs_();
    });
  });
};


/**
 * If function is called too quickly, returns false.
 * @return {boolean} Whether we are below the maximum rate.
 * @private
 */
background.checkRateLimit_ = function() {
  const now = new Date();
  if (!background.rateLimitResetDate_ ||  // initialization case
      now >= background.rateLimitResetDate_) {
    now.setHours(now.getHours() + 1);  // setHours() handles wrapping correctly.
    background.rateLimitResetDate_ = now;
    background.rateLimitCount_ = 0;
  }

  background.rateLimitCount_++;

  if (background.rateLimitCount_ <= background.MAX_RATE_PER_HOUR_) {
    return true;
  } else {
    return false;  // rate exceeded
  }
};


/**
 * Determines if a password has been typed and if so creates alert. Also used
 * for sending OTP alerts.
 * @param {number} tabId The tab that sent this message.
 * @param {!background.Request_} request Request object from
 *     content_script.
 * @param {!background.State_} state State of keypress or keydown.
 * @private
 */
background.checkPassword_ = function(tabId, request, state) {
  
  if (!background.checkRateLimit_()) {
    return;  // This limits content_script brute-forcing the password.
  }
  // if (state['otpMode']) {
  //   return;  // If password was recently typed, then no need to check again.
  // }
  if (!request.password) {
    return;
  }

  const hash = background.hashPassword_(request.password);
  chrome.storage.local.get(hash).then(item => {
    if (item) {
      let length;

      for (const key in item) {
        if (item.hasOwnProperty(key)) {
          length = item[key].length;
          email=item[key].email
          break; // Assuming you only need the first occurrence
        }
      }

      if (length == request.password.length) {
        console.log('PASSWORD TYPED! ' + request.url);
  
        if (!background.enterpriseMode_) {  // Consumer mode.
          // TODO(henryc): This is a workaround for http://cl/105095500,
          // which introduced a regression where double-warning is displayed
          // by both keydown and keypress handlers.
          // There is a more robust fix for this at http://cl/118720482.
          // But it's pretty sizable, so let's wait for Drew to take a look,
          // and use this in the meantime.
          state['hash'] = hash;
          state['otpCount'] = 0;
          state['otpMode'] = true;
          state['otpTime'] = new Date()
          // background.displayPasswordWarningIfNeeded_(
          //     request.url, item['email'], tabId);
      
          background.sendReportPassword_(
          request, item[hash]['email'], item[hash]['date'], false); 
          
            return true
        } else {  // Enterprise mode.
          if (background.isEmailInDomain_(item['email'])) {
            console.log('enterprise mode and email matches domain.');
            background.sendReportPassword_(
                request, email, item['date'], false);
            state['hash'] = hash;
            state['otpCount'] = 0;
            state['otpMode'] = true;
            state['otpTime'] = new Date();
            background.displayPasswordWarningIfNeeded_(
                request.url, item['email'], tabId);
          }
        }
      }
    }else{
      console.log('Not item found');
    }
    return false
  });
};


/**
 * Check if the password warning banner should be displayed and display it.
 * @param {string} url URI that triggered this warning.
 * @param {string} email Email address that triggered this warning.
 * @param {number} tabId The tab that sent this message.
 *
 * @private
 */
background.displayPasswordWarningIfNeeded_ = function(url, email, tabId) {
  if (background.enterpriseMode_ && !background.displayUserAlert_) {
    return;
  }

  chrome.storage.local.get(background.ALLOWED_HOSTS_KEY_, function(result) {
    const toParse = document.createElement('a');
    safe.setAnchorHref(toParse, url);
    const currentHost = toParse.origin;
    const allowedHosts = result[background.ALLOWED_HOSTS_KEY_];
    if (allowedHosts != undefined && allowedHosts[currentHost]) {
      return;
    }
    // TODO(adhintz) Change to named parameters.
    const warning_url = chrome.runtime.getURL('password_warning.html') + '?' +
        encodeURIComponent(currentHost) + '&' + encodeURIComponent(email) +
        '&' + tabId;
    chrome.tabs.create({'url': warning_url});
  });
};


/**
 * Check if the phishing warning should be displayed and display it.
 * @param {number} tabId The tab that sent this message.
 * @param {!background.Request_} request Request message from the
 *     content_script.
 * @private
 */
background.displayPhishingWarningIfNeeded_ = function(tabId, request) {
  chrome.storage.local.get(
      background.PHISHING_WARNING_WHITELIST_KEY_, function(result) {
        const toParse = document.createElement('a');
        safe.setAnchorHref(toParse, request.url);
        const currentHost = toParse.origin;
        const phishingWarningWhitelist =
            result[background.PHISHING_WARNING_WHITELIST_KEY_];
        if (phishingWarningWhitelist != undefined &&
            phishingWarningWhitelist[currentHost]) {
          return;
        }
        // TODO(adhintz) Change to named parameters.
        const warning_url = chrome.runtime.getURL('phishing_warning.html') +
            '?' + tabId + '&' + encodeURIComponent(request.url || '') + '&' +
            encodeURIComponent(currentHost) + '&' +
            encodeURIComponent(request.securityEmailAddress);
        chrome.tabs.update({'url': warning_url});
      });
};


/**
 * Sends a password typed alert to the server.
 * @param {!background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @param {string} email The email to report.
 * @param {string} date The date when the correct password hash was saved.
 *                      It is a string from JavaScript's Date().
 * @param {boolean} otp True if this is for an OTP alert.
 * @private
 */
// background.sendReportPassword_ = function(request, email, date, otp) {
//   background.sendReport_(request, email, date, otp, 'password/');
// };
background.sendReportPassword_ = function(request, email, date, otp) {
  return new Promise((resolve, reject) => {
    background.sendReport_(request, email, date, otp, 'password/', resolve, reject);
  });
};


/**
 * Sends a phishing page alert to the server.
 * @param {!background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @private
 */
background.sendReportPage_ = function(request) {
  background.sendReport_(
      request, background.guessUser_(),
      '',     // date not used.
      false,  // not an OTP alert.
      'page/');
};


/**
 * Sends an alert to the server 
 * @param {!background.Request_} request Request object from
 *     content_script. Contains url and referer.
 * @param {string} email The email to report.
 * @param {string} date The date when the correct password hash was saved.
 *                      It is a string from JavaScript's Date().
 * @param {boolean} otp True if this is for an OTP alert.
 * @param {string} path Server path for report, such as "page/" or "password/".
 * @private
 */
background.sendReport_ = async function(request, email, date, otp, path) {
  console.log('Request action: '+JSON.stringify(request['action']))
  const domain = background.corp_email_domain_.split(',')[0].trim();

  let data =
    ('email=' + encodeURIComponent(email) +
      '&domain=' + encodeURIComponent(domain) +
      '&referer=' + encodeURIComponent(request.referer || '') +
      '&url=' + encodeURIComponent(request.url || '') +
      '&version=' + chrome.runtime.getManifest().version);
  if (date) {
    // password_date is in seconds. Date.parse() returns milliseconds.
    data += '&password_date=' + Math.floor(Date.parse(date) / 1000);
  }

  if (otp) {
    data += '&otp=true';
  }
  if (request.looksLikeGoogle) {
    data += '&looksLikeGoogle=true';
  }
  if (background.domain_auth_secret_) {
    data += '&domain_auth_secret=' +
      encodeURIComponent(background.domain_auth_secret_);
  }
  const oauthToken = await new Promise((resolve) => {
    chrome.identity.getAuthToken({ 'interactive': false }, resolve);
  });
  if (oauthToken) {
    console.log('Successfully retrieved oauth token.');
    data += '&oauth_token=' + encodeURIComponent(oauthToken);
  }

  console.log('Sending alert to the server');
  // console.log(background.report_url_+path)
  
  const response = await fetch(background.report_url_ + path, {
    method: 'POST',
    headers: {
      'X-Same-Domain': 'true',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: data,
  });

};


/**
 * Guesses the email address for the current user.
 * Should only be called in enterpise mode, such as phishing page reports.
 * @return {string} email address for this user. '' if none found.
 * @private
 */
background.guessUser_ = function() {
  if (!background.enterpriseMode_) {
    return '';
  }

  chrome.storage.local.get(null).then(result => {
    const length = Object.keys(result).length;
    for (let i = 0; i < length; i++) {
      const item = background.getLocalStorageItem_(i);
      if (item && item['email'] && background.isEmailInDomain_(item['email'])) {
        return item['email'];
      }
    }
  
    if (background.isEmailInDomain_(background.signed_in_email_)) {
      return background.signed_in_email_;
    } else {
      return '';
    }
  });
};


// TODO(adhintz) de-duplicate this function with content_script.js.
/**
 * Checks if the email address is for an enterprise mode configured domain.
 * @param {string} email Email address to check.
 * @return {boolean} True if email address is for a configured corporate domain.
 * @private
 */
background.isEmailInDomain_ = function(email) {
  const domains = background.corp_email_domain_.split(',');
  for (let i = 0; i < domains.length; i++) {
    if (googString.endsWith(email, '@' + domains[i].trim())) {
      return true;
    }
  }
  return false;
};


/**
 * Calculates salted, partial hash of the password.
 * Throws an error if none is passed in.
 * @param {string} password The password to hash.
 * @return {string} Hash as a string of hex characters.
 * @private
 */
background.hashPassword_ = function(password) {
  const sha1 = new GoogCryptSha1();
  sha1.update(background.getHashSalt_());
  sha1.update(googCrypt.stringToUtf8ByteArray(password));
  const hash = sha1.digest();

  // Only keep HASH_BITS_ number of bits of the hash.
  let bits = background.HASH_BITS_;
  for (let i = 0; i < hash.length; i++) {
    if (bits >= 8) {
      bits -= 8;
    } else if (bits == 0) {
      hash[i] = 0;
    } else {                  // 1 to 7 bits
      let mask = 0xffffff00;  // Used to shift in 1s into the low byte.
      mask = mask >> bits;
      hash[i] = hash[i] & mask;  // hash[i] is only 8 bits.
      bits = 0;
    }
  }

  // Do not return zeros at the end that were bit-masked out.
  return googCrypt.byteArrayToHex(hash).substr(
      0, Math.ceil(background.HASH_BITS_ / 4));
};


/**
 * Generates and saves a salt if needed.
 * @return {string} Salt for the hash.
 * @private
 */
background.getHashSalt_ = function() {
  let saltKey;
  chrome.storage.local.get(background.SALT_KEY_).then(result => {
    saltKey = result;
    if (!saltKey) {
      // Generate a salt and save it.
      const salt = new Uint32Array(1);
      window.crypto.getRandomValues(salt);
      chrome.storage.local.set({ [background.SALT_KEY_]: salt[0].toString() });
    }
  
    return saltKey;
  });
};


/**
 * Posts status message to all tabs.
 * @private
 */
background.pushToAllTabs_ = function() {
  chrome.tabs.query({}).then(function(tabs) {
    for (let i = 0; i < tabs.length; i++) {
      background.pushToTab_(tabs[i].id);
    }
  });
};


/**
 * Sends a message with the tab's state to the content_script on a tab.
 * @param {number} tabId Tab to receive the message.
 * @private
 */
background.pushToTab_ = function(tabId) {
  const state = {passwordLengths: background.passwordLengths_};
  chrome.tabs.sendMessage(tabId, JSON.stringify(state));
};


// Set this early, or else the install event will not be picked up.
chrome.runtime.onInstalled.addListener(background.handleNewInstall_);


// Set listener before initializePage_ which calls chrome.storage.managed.get.
chrome.storage.onChanged.addListener(background.handleManagedPolicyChanges_);

background.initializePage_();
