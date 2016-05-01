var cors = require('cors');
var uuid = require('uuid');
var RSVP = require('rsvp');
var _ = require('underscore');

function debug() {
    if (exports.debug_mode) {
        console.error.apply(this, arguments);
    }
}
exports.debug_mode = /\bguest-history\b/i.test(process.env.NODE_DEBUG);


// This is the heart of your HipChat Connect add-on. For more information,
// take a look at https://developer.atlassian.com/hipchat/guide
module.exports = function (app, addon) {
    var hipchat = require('../lib/hipchat')(addon);

    // Root route. This route will serve the `addon.json` unless a homepage URL is
    // specified in `addon.json`.
    app.get('/',
        function (req, res) {
            // Use content-type negotiation to choose the best way to respond
            res.format({
                // If the request content-type is text-html, it will decide which to serve up
                'text/html': function () {
                    res.redirect(addon.descriptor.links.homepage);
                },
                // This logic is here to make sure that the `addon.json` is always
                // served up when requested by the host
                'application/json': function () {
                    debug("request for atlassian-connect.json");
                    res.redirect('/atlassian-connect.json');
                }
            });
        }
    );

    // This is an example route that's used by the default for the configuration page
    // https://developer.atlassian.com/hipchat/guide/hipchat-ui-extensions/configuration-page
    app.get('/config',
        // Authenticates the request using the JWT token in the request
        addon.authenticate(),
        function (req, res) {
            console.log(req.context);
            // The `addon.authenticate()` middleware populates the following:
            // * req.clientInfo: useful information about the add-on client such as the
            //   clientKey, oauth info, and HipChat account info
            // * req.context: contains the context data accompanying the request like
            //   the roomId
            debug("request for /config");
            res.render('config', req.context);
        }
    );

    var glanceJson = function (isSuccess) {
        debug("returning glance JSON: ", isSuccess);
        return {
            "label": {
                "type": "html",
                "value": "Guest History"
            },
            "status": {
                "type": "lozenge",
                "value": {
                    "label": isSuccess ? "enabled" : "disabled",
                    "type": isSuccess ? "success" : "default"
                }
            }
        };
    };

    app.get('/glance',
        cors(),
        addon.authenticate(),
        function (req, res) {
            debug("request for /glance");
            isRoomGuestHistoryEnabled(req.clientInfo.clientKey, req.identity.roomId)
                .then(function (enabled) {
                    res.json(glanceJson(enabled));
                });
        }
    );

    app.post('/config/room',
        addon.authenticate(),
        function (req, res) {
            var enabled = flagToBoolean(req.body.value);

            debug("request for /config/room: ", enabled);
            isRoomGuestHistoryEnabled(req.clientInfo.clientKey, req.identity.roomId)
                .then(function (currState) {
                    if (currState != enabled) {
                        setRoomGuestHistoryEnabled(req.clientInfo, req.identity.roomId, enabled, req.identity)
                            .then(function (nil) {
                                debug("guest history flag set: ", enabled);
                                hipchat.updateGlance(req.clientInfo, req.identity.roomId, "guest-history-glance", glanceJson(enabled))
                                    .then(function (nil) {
                                        debug("glance updated", enabled);
                                        res.sendStatus(204);
                                    }, defaultErrorHandler("update room glance", res));
                            }, defaultErrorHandler("set history flag", res));
                    } else {
                        debug("history flag already set to: ", enabled);
                        res.sendStatus(204);
                    }
                }, defaultErrorHandler("get history flag", res));
        }
    );

    app.post('/config/room/greeting',
        addon.authenticate(),
        function (req, res) {
            var enabled = flagToBoolean(req.body.value);

            debug("request for /config/room/greeting: ", enabled);
            isRoomGuestGreetingEnabled(req.clientInfo.clientKey, req.identity.roomId)
                .then(function (currState) {
                    if (currState != enabled) {
                        setRoomGuestGreetingEnabled(req.clientInfo, req.identity.roomId, enabled)
                            .then(function (nil) {
                                debug("guest greeting flag set: ", enabled);
                                res.sendStatus(204);
                            }, defaultErrorHandler("set history flag", res));
                    } else {
                        debug("greeting flag already set to: ", enabled);
                        res.sendStatus(204);
                    }
                }, defaultErrorHandler("get history flag", res));
        }
    );

    app.get('/sidebar',
        addon.authenticate(),
        function (req, res) {
            debug('sidebar identity: ', req.identity);
            isRoomGuestHistoryEnabled(req.clientInfo.clientKey, req.identity.roomId)
                .then(function (historyFlag) {
                    isRoomGuestGreetingEnabled(req.clientInfo.clientKey, req.identity.roomId)
                        .then(function (greetingFlag) {
                            debug("rendering sidebar");
                            res.render('sidebar', {
                                identity: req.identity,
                                historyFlag: historyFlag,
                                greetingFlag: greetingFlag
                            });
                        });
                });
        }
    );

    var flagToBoolean = function (flag) {
        return (_.isString(flag) && flag.toLowerCase().trim() == 'true')
            || (_.isBoolean(flag) && flag);
    };

    var defaultNoContent = function (res) {
        return function (data) {
            res.sendStatus(204);
        }
    };

    var defaultErrorHandler = function (opName, res) {
        return function (error) {
            res.status(500).json(error);
            console.log(opName, error);
        }
    };

    var withUser = function (req, res, userId, userCallback) {
        hipchat.getUser(req.clientInfo, userId)
            .then(function (userRes) {

                if (userRes.statusCode >= 200 && userRes.statusCode < 300) {
                    userCallback(userRes.body);
                } else {
                    res.status(500).json(userRes.body);
                    // console.log('error',userRes.body);
                }
            }, defaultErrorHandler("get user", res));
    };

    var newHook = function(type, event) {
        return {
            "url": addon.config.localBaseUrl() + "/" + type,
            "event": event,
            "authentication": "jwt",
            "name": type + " webhook"
        }
    };

    var setRoomGuestGreetingEnabled = function (clientInfo, roomId, enabled) {
        debug("setting greeting flag: ", enabled);
        var promise = addon.settings.set('greeting_flag:' + roomId, enabled, clientInfo.clientKey);

        if (enabled) {
            return promise.then(function (nil) {
                var greetingHook = newHook("greeting", "room_enter");

                return addon.settings.get("history_hooks:" + identity.roomId, clientInfo.clientKey)
                    .then(function (hookStorage) {
                        hookStorage = hookStorage || [];

                        return hipchat.addRoomWebhook(clientInfo, identity.roomId, greetingHook)
                            .then(function (greetingHookRes) {
                                debug("adding hook: ", greetingHook.url, " gotId: ", greetingHookRes.body.id);

                                hookStorage.push({
                                    type: "greeting",
                                    id: greetingHookRes.body.id
                                });

                                return addon.settings.set("history_hooks:" + identity.roomId, hookStorage, clientInfo.clientKey);
                            });
                    });
            });
        } else {
            return promise.then(function (nil) {
                debug("removing hooks");
                return removeGuestHistoryTokenByRoom(clientInfo.clientKey, identity.roomId)
                    .then(function (token) {
                        addon.settings.client.del('history_token:' + token);
                        debug("history token removed: ", token);
                        return addon.settings.get("history_hooks:" + identity.roomId, clientInfo.clientKey)
                            .then(function (obj) {
                                for (var i in obj.hooks) {
                                    debug("removing hook: ", obj.hooks[i]);
                                    hipchat.removeRoomWebhook(clientInfo, identity.roomId, obj.hooks[i]);
                                }

                                return addon.settings.del("history_hooks:" + identity.roomId, clientInfo.clientKey);
                            });
                    });
            });
        }
    };

    var setRoomGuestHistoryEnabled = function (clientInfo, roomId, enabled, identity) {
        debug("setting history flag: ", enabled);
        var promise = addon.settings.set('history_flag:' + roomId, enabled, clientInfo.clientKey);

        if (enabled) {
            return promise.then(function (nil) {
                debug("adding hooks");
                var greetingHook = newHook("greeting", "room_enter");
                var historyHook = newHook("history", "room_message");

                return hipchat.addRoomWebhook(clientInfo, identity.roomId, greetingHook)
                    .then(function (greetingHookRes) {
                        debug("adding hook: ", greetingHook.url, " gotId: ", greetingHookRes.body.id);
                        return hipchat.addRoomWebhook(clientInfo, identity.roomId, historyHook)
                            .then(function (historyHookRes) {
                                debug("adding hook: ", historyHook.url, " gotId: ", historyHookRes.body.id);

                                var hookStorage = {
                                    hooks: [{
                                        type: "greeting",
                                        id: greetingHookRes.body.id
                                    }, {
                                        type: "history",
                                        id: historyHookRes.body.id
                                    }]
                                };

                                return addon.settings.set("history_hooks:" + identity.roomId, hookStorage, clientInfo.clientKey);
                            });
                    });
            });
        } else {
            return promise.then(function (nil) {
                debug("removing hooks");
                return removeGuestHistoryTokenByRoom(clientInfo.clientKey, identity.roomId)
                    .then(function (token) {
                        addon.settings.client.del('history_token:' + token);
                        debug("history token removed: ", token);
                        return addon.settings.get("history_hooks:" + identity.roomId, clientInfo.clientKey)
                            .then(function (obj) {
                                for (var i in obj.hooks) {
                                    debug("removing hook: ", obj.hooks[i]);
                                    hipchat.removeRoomWebhook(clientInfo, identity.roomId, obj.hooks[i]);
                                }

                                return addon.settings.del("history_hooks:" + identity.roomId, clientInfo.clientKey);
                            });
                    });
            });
        }
    };

    var isRoomGuestHistoryEnabled = function (clientKey, roomId) {
        return isRoomGuestFlagEnabled("history", clientKey, roomId);
    };

    var isRoomGuestGreetingEnabled = function (clientKey, roomId) {
        return isRoomGuestFlagEnabled("greeting", clientKey, roomId);
    };

    var isRoomGuestFlagEnabled = function (flagName, clientKey, roomId) {
        return addon.settings.get(flagName + '_flag:' + roomId, clientKey)
            .then(function (enabled) {
                debug(flagName, 'flag check: ', roomId, clientKey, flagToBoolean(enabled));
                return flagToBoolean(enabled);
            });
    };

    var getOrCreateGuestHistoryLinkByRoom = function (clientKey, room) {
        debug("finding history token");
        return addon.settings.get('history_token:' + room.id, clientKey)
            .then(function (token) {
                debug("history token: ", token);
                if (token) {
                    return addon.config.localBaseUrl() + '/history/' + token;
                } else {
                    var token = uuid.v4();
                    debug("generated new history token: ", token);

                    var promise = new RSVP.Promise(function (resolve, reject) {
                        var value = {
                            "clientKey": clientKey,
                            "room": {
                                id: room.id,
                                name: room.name
                            }
                        };
                        addon.settings.client.set(
                            'history_token:' + token,
                            JSON.stringify(value, null, 2),
                            function (err, res) {
                                if (!err) {
                                    resolve(addon.settings.set('history_token:' + room.id, token, clientKey)
                                        .then(function (val) {
                                            return addon.config.localBaseUrl() + '/history/' + token;
                                        }));
                                } else {
                                    reject(err);
                                }
                            });
                    });

                    return promise;
                }
            });
    };

    var getRoomContextFromGuestHistoryToken = function (token) {
        debug("getting room ctx for token: ", token);
        return new RSVP.Promise(function (resolve, reject) {
            addon.settings.client.get('history_token:' + token, function (err, res) {
                if (!err) {
                    debug("found ctx: ", res);
                    resolve(res ? JSON.parse(res) : res);
                } else {
                    debug("missing ctx");
                    reject(err);
                }
            });
        });
    };

    var removeGuestHistoryTokenByRoom = function (clientKey, roomId) {
        debug("removing history token");
        return addon.settings.get('history_token:' + roomId, clientKey)
            .then(function (token) {
                if (token) {
                    addon.settings.client.del('history_token:' + token);
                    addon.settings.del('history_token:' + roomId, clientKey);
                    debug("history token removed");
                }
                return token;
            });
    };

    app.get('/privacy',
        function (req, res) {
            debug("getting privacy page");
            res.render('privacy', {
                title: "Data security & privacy statement",
                subtitle: "Make message history public and protect your team's security"
            });
        }
    );

    app.get('/donate',
        function (req, res) {
            debug("getting donation page");
            res.render('donate', {
                title: "Your support is needed",
                subtitle: "If you like this add-on help it survive"
            });
        }
    );

    app.get('/history/:token',
        function (req, res) {
            debug('history link: ', req.params.token);
            if (req.params.token) {
                getRoomContextFromGuestHistoryToken(req.params.token)
                    .then(function (roomCtx) {
                        if (roomCtx) {
                            res.render('history', {
                                title: roomCtx.room.name + " History",
                                subtitle: "Listing latest 150 messages"
                            });
                        } else {
                            res.status(500).json({error: "Token is invalid"});
                        }
                    }, defaultErrorHandler("get room context", res));
            } else {
                res.status(500).json({error: "Missing Token"});
            }
        }
    );

    app.get('/history/:token/latest',
        function (req, res) {
            debug('latest history token: ', req.params.token);
            if (req.params.token) {
                getRoomContextFromGuestHistoryToken(req.params.token)
                    .then(function (roomCtx) {
                        if (roomCtx) {
                            addon.settings.get('clientInfo', roomCtx.clientKey)
                                .then(function (clientInfo) {
                                    hipchat.getLatestHistory(clientInfo, roomCtx.room.id, 150)
                                        .then(function (history) {
                                            res.status(200).json(history.body);
                                        }, defaultErrorHandler("get room history", res));
                                }, defaultErrorHandler("get clientInfo", res));
                        } else {
                            res.status(500).json({error: "Token is invalid"});
                        }
                    }, defaultErrorHandler("get room context", res));
            } else {
                res.status(500).json({error: "Missing Token"});
            }
        }
    );

    app.post('/greeting|/history',
        addon.authenticate(),
        function (req, res) {
            debug("hook called: ", req.body);

            var userId = req.body.event === "room_message" ? req.body.item.message.from.id : req.body.item.sender.id;
            var eventType = req.body.event === "room_message" ? "history" : "greeting";
            withUser(req, res, userId, function (user) {
                debug('-> user: ', user.name);
                if (user.is_guest) {
                    debug("user is guest");
                    var room = req.body.item.room;

                    isRoomGuestHistoryEnabled(req.clientInfo.clientKey, room.id)
                        .then(function (historyFlag) {
                            debug("history flag:", historyFlag);
                            if (historyFlag) {
                                isRoomGuestGreetingEnabled(req.clientInfo.clientKey, room.id)
                                    .then(function (greetingFlag) {
                                        debug('greeting flag:', greetingFlag);
                                        if (eventType == 'greeting' && greetingFlag || eventType == 'history') {
                                            getOrCreateGuestHistoryLinkByRoom(req.clientInfo.clientKey, room)
                                                .then(function (link) {
                                                    debug('history link: ', link);

                                                    var card = {
                                                        "style": "link",
                                                        "url": link,
                                                        "id": uuid.v4(),
                                                        "title": "Looking for room history? ...follow me",
                                                        "description": "Hi " + user.name + "! Use this link to browse through messages from your teammates. You can also type '/history' in chat to see this card again.",
                                                        "icon": {
                                                            "url": addon.config.localBaseUrl() + "/img/History-transparent-128.png"
                                                        }
                                                    };
                                                    var msg = card.title + card.description;
                                                    var opts = {'options': {'color': 'green'}};

                                                    hipchat.sendMessage(req.clientInfo, room.id, msg, opts, card)
                                                        .then(defaultNoContent(res), defaultErrorHandler("send message", res));

                                                }, defaultErrorHandler("get link", res));
                                        } else {
                                            res.sendStatus(204);
                                        }
                                    });
                            } else {
                                res.sendStatus(204);
                            }
                        }, defaultErrorHandler("is guest enabled", res));
                } else {
                    res.sendStatus(204);
                }
            });
        }
    );


    // Clean up clients when uninstalled
    addon.on('uninstalled', function (clientKey) {
        debug('Removing Installation:', clientKey);

        addon.settings.client.keys(clientKey + ':history_token:*', function (err, vals) {
            vals.forEach(function (k) {
                addon.settings.client.get(k, function (err, token) {
                    debug('removing token', token);
                    if (token) {
                        token = JSON.parse(token);
                        addon.settings.client.del('history_token:' + token);
                    }
                });
            });
        });

        addon.settings.client.keys(clientKey + ':*', function (err, rep) {
            rep.forEach(function (k) {
                debug('Removing key:', k);
                addon.settings.client.del(k);
            });
        });
        res.sendStatus(204);
    });
};
