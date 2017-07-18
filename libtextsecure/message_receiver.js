/*
 * vim: ts=4:sw=4:expandtab
 */

function MessageReceiver(url, ports, username, password, signalingKey) {
    this.url = url;
    this.signalingKey = signalingKey;
    this.username = username;
    this.password = password;
    this.server = new TextSecureServer(url, ports, username, password);

    var address = libsignal.SignalProtocolAddress.fromString(username);
    this.number = address.getName();
    this.deviceId = address.getDeviceId();
}

MessageReceiver.prototype = new textsecure.EventTarget();
MessageReceiver.prototype.extend({
    constructor: MessageReceiver,
    connect: function() {
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            this.socket.close();
        }
        // initialize the socket and start listening for messages
        this.socket = this.server.getMessageSocket();
        this.socket.onclose = this.onclose.bind(this);
        this.socket.onerror = this.onerror.bind(this);
        this.socket.onopen = this.onopen.bind(this);
        this.wsr = new WebSocketResource(this.socket, {
            handleRequest: this.handleRequest.bind(this),
            keepalive: { path: '/v1/keepalive', disconnect: true }
        });

        this.pending = Promise.resolve();

        this.queueAllUnprocessed();
    },
    close: function() {
        this.socket.close(3000, 'called close');
        delete this.listeners;
    },
    onopen: function() {
        console.log('websocket open');
    },
    onerror: function(error) {
        console.log('websocket error');
    },
    onclose: function(ev) {
        console.log('websocket closed', ev.code, ev.reason || '');
        if (ev.code === 3000) {
            return;
        }
        var eventTarget = this;
        // possible 403 or network issue. Make an request to confirm
        this.server.getDevices(this.number).
            then(this.connect.bind(this)). // No HTTP error? Reconnect
            catch(function(e) {
                var ev = new Event('error');
                ev.error = e;
                eventTarget.dispatchEvent(ev);
            });
    },
    handleRequest: function(request) {
        // We do the message decryption here, instead of in the ordered pending queue,
        // to avoid exposing the time it took us to process messages through the time-to-ack.

        // TODO: handle different types of requests.
        if (request.path !== '/api/v1/message') {
            console.log('got request', request.verb, request.path);
            request.respond(200, 'OK');
            return;
        }

        textsecure.crypto.decryptWebsocketMessage(request.body, this.signalingKey).then(function(plaintext) {
            var envelope = textsecure.protobuf.Envelope.decode(plaintext);
            // After this point, decoding errors are not the server's
            // fault, and we should handle them gracefully and tell the
            // user they received an invalid message

            if (this.isBlocked(envelope.source)) {
                return request.respond(200, 'OK');
            }

            this.addToUnprocessed(envelope, plaintext).then(function() {
                request.respond(200, 'OK');
                this.queueEnvelope(envelope);
            }.bind(this));
        }.bind(this)).catch(function(e) {
            request.respond(500, 'Bad encrypted websocket message');
            console.log("Error handling incoming message:", e && e.stack ? e.stack : e);
            var ev = new Event('error');
            ev.error = e;
            this.dispatchEvent(ev);
        }.bind(this));
    },
    queueAllUnprocessed: function() {
        this.loadAllUnprocessed().then(function(items) {
            for (var i = 0, max = items.length; i < max; i += 1) {
                var item = items[i];

                if (item.unprocessed.get('decrypted')) {
                    var plaintext = this.stringToArrayBuffer(item.unprocessed.get('decrypted'));
                    this.handleDecryptedEnvelope(item.envelope, plaintext);
                } else {
                    this.queueEnvelope(item.envelope);
                }
            }
        }.bind(this));
    },
    loadAllUnprocessed: function() {
        console.log('loadAllUnprocessed');
        var collection;
        return new Promise(function(resolve, reject) {
            collection = new Whisper.UnprocessedCollection();
            return collection.fetch().then(resolve, reject);
        }).then(function() {
            console.log('loadAllUnprocessed, loaded', collection.length, 'saved envelopes');

            // Using a separate array since we might be destroying models, which will
            //   cause iteration to go wacky.
            var all = collection.map(_.identity);

            var items = _.map(all, function(unprocessed) {
                var attempts = 1 + (unprocessed.get('attempts') || 0);
                if (attempts >= 5) {
                    unprocessed.destroy();
                } else {
                    unprocessed.save({attempts: attempts});
                }

                var plaintext = this.stringToArrayBuffer(unprocessed.get('envelope'));
                var envelope = textsecure.protobuf.Envelope.decode(plaintext);

                // This is post-decode to ensure that we don't try infinitely on an error
                if (attempts >= 5) {
                    console.log('loadAllUnprocessed, final attempt for envelope', this.getEnvelopeId(envelope));
                }

                return {
                    envelope: envelope,
                    unprocessed: unprocessed
                };
            }.bind(this));

            return items;
        }.bind(this));
    },
    getEnvelopeId: function(envelope) {
        return envelope.source + '.' + envelope.sourceDevice + ' ' + envelope.timestamp.toNumber();
    },
    arrayBufferToString: function(arrayBuffer) {
        return new dcodeIO.ByteBuffer.wrap(arrayBuffer).toString('binary');
    },
    stringToArrayBuffer: function(string) {
        return new dcodeIO.ByteBuffer.wrap(string, 'binary').toArrayBuffer();
    },
    addToUnprocessed: function(envelope, plaintext) {
        console.log('addToUnprocessed', this.getEnvelopeId(envelope));
        return new Promise(function(resolve, reject) {
            var id = this.getEnvelopeId(envelope);
            var string = this.arrayBufferToString(plaintext);
            var unprocessed = new Whisper.Unprocessed({
                id: id,
                envelope: string,
                timestamp: Date.now(),
                attempts: 1
            });
            return unprocessed.save().then(resolve, reject);
        }.bind(this));
    },
    updateUnprocessed: function(envelope, plaintext) {
        console.log('updateUnprocessed', this.getEnvelopeId(envelope));
        return new Promise(function(resolve, reject) {
            var id = this.getEnvelopeId(envelope);
            var string = this.arrayBufferToString(plaintext);
            var unprocessed = new Whisper.Unprocessed({
                id: id
            });
            return unprocessed.fetch().then(function() {
                return unprocessed.save({decrypted: string}).then(resolve, reject);
            }, reject)
        }.bind(this));
    },
    removeFromUnprocessed: function(envelope) {
        console.log('removeFromUnprocessed', this.getEnvelopeId(envelope));
        return new Promise(function(resolve, reject) {
            var id = this.getEnvelopeId(envelope);
            var unprocessed = new Whisper.Unprocessed({
                id: id
            });
            return unprocessed.destroy().then(resolve, reject);
        }.bind(this));
    },
    queueEnvelope: function(envelope) {
        console.log('queueing envelope', this.getEnvelopeId(envelope));
        var handleEnvelope = this.handleEnvelope.bind(this, envelope);
        this.pending = this.pending.then(handleEnvelope, handleEnvelope);

        return this.pending.catch(function(error) {
            console.log('queueEnvelope error:', error && error.stack ? error.stack : error);
        });
    },
    // Same as handleEnvelope, just without the decryption step. Necessary for handling
    //   messages which were successfully decrypted, but application logic didn't finish
    //   processing.
    handleDecryptedEnvelope: function(envelope, plaintext) {
        // No decryption is required for delivery receipts, so the decrypted field of
        //   the Unprocessed model will never be set

        if (envelope.content) {
            return this.innerHandleContentMessage(envelope, plaintext);
        } else if (envelope.legacyMessage) {
            return this.innerHandleLegacyMessage(envelope, plaintext);
        } else {
            this.removeFromUnprocessed(envelope);
            throw new Error('Received message with no content and no legacyMessage');
        }
    },
    handleEnvelope: function(envelope) {
        if (envelope.type === textsecure.protobuf.Envelope.Type.RECEIPT) {
            return this.onDeliveryReceipt(envelope);
        }

        if (envelope.content) {
            return this.handleContentMessage(envelope);
        } else if (envelope.legacyMessage) {
            return this.handleLegacyMessage(envelope);
        } else {
            this.removeFromUnprocessed(envelope);
            throw new Error('Received message with no content and no legacyMessage');
        }
    },
    getStatus: function() {
        if (this.socket) {
            return this.socket.readyState;
        } else {
            return -1;
        }
    },
    onDeliveryReceipt: function (envelope) {
        return new Promise(function(resolve) {
            var ev = new Event('receipt');
            ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
            ev.proto = envelope;
            this.dispatchEvent(ev);
            return resolve();
        }.bind(this));
    },
    unpad: function(paddedPlaintext) {
        paddedPlaintext = new Uint8Array(paddedPlaintext);
        var plaintext;
        for (var i = paddedPlaintext.length - 1; i >= 0; i--) {
            if (paddedPlaintext[i] == 0x80) {
                plaintext = new Uint8Array(i);
                plaintext.set(paddedPlaintext.subarray(0, i));
                plaintext = plaintext.buffer;
                break;
            } else if (paddedPlaintext[i] !== 0x00) {
                throw new Error('Invalid padding');
            }
        }

        return plaintext;
    },
    decrypt: function(envelope, ciphertext) {
        var promise;
        var address = new libsignal.SignalProtocolAddress(envelope.source, envelope.sourceDevice);
        var sessionCipher = new libsignal.SessionCipher(textsecure.storage.protocol, address);
        switch(envelope.type) {
            case textsecure.protobuf.Envelope.Type.CIPHERTEXT:
                console.log('message from', this.getEnvelopeId(envelope));
                promise = sessionCipher.decryptWhisperMessage(ciphertext).then(this.unpad);
                break;
            case textsecure.protobuf.Envelope.Type.PREKEY_BUNDLE:
                console.log('prekey message from', this.getEnvelopeId(envelope));
                promise = this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address);
                break;
            default:
                promise = Promise.reject(new Error("Unknown message type"));
        }
        return promise.then(function(plaintext) {
            this.updateUnprocessed(envelope, plaintext);
            return plaintext;
        }.bind(this)).catch(function(error) {
            if (error.message === 'Unknown identity key') {
                // create an error that the UI will pick up and ask the
                // user if they want to re-negotiate
                var buffer = dcodeIO.ByteBuffer.wrap(ciphertext);
                error = new textsecure.IncomingIdentityKeyError(
                    address.toString(),
                    buffer.toArrayBuffer(),
                    error.identityKey
                );
            }
            var ev = new Event('error');
            ev.error = error;
            ev.proto = envelope;
            this.dispatchEvent(ev);
            return Promise.reject(error);
        }.bind(this));
    },
    decryptPreKeyWhisperMessage: function(ciphertext, sessionCipher, address) {
        return sessionCipher.decryptPreKeyWhisperMessage(ciphertext).then(this.unpad).catch(function(e) {
            if (e.message === 'Unknown identity key') {
                // create an error that the UI will pick up and ask the
                // user if they want to re-negotiate
                var buffer = dcodeIO.ByteBuffer.wrap(ciphertext);
                throw new textsecure.IncomingIdentityKeyError(
                    address.toString(),
                    buffer.toArrayBuffer(),
                    e.identityKey
                );
            }
            throw e;
        });
    },
    handleSentMessage: function(envelope, destination, timestamp, message, expirationStartTimestamp) {
        var p = Promise.resolve();
        if ((message.flags & textsecure.protobuf.DataMessage.Flags.END_SESSION) ==
                textsecure.protobuf.DataMessage.Flags.END_SESSION ) {
            p = this.handleEndSession(destination);
        }
        return p.then(function() {
            return this.processDecrypted(message, this.number).then(function(message) {
                var ev = new Event('sent');
                ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
                ev.data = {
                    destination              : destination,
                    timestamp                : timestamp.toNumber(),
                    message                  : message
                };
                if (expirationStartTimestamp) {
                  ev.data.expirationStartTimestamp = expirationStartTimestamp.toNumber();
                }
                this.dispatchEvent(ev);
            }.bind(this));
        }.bind(this));
    },
    handleDataMessage: function(envelope, message) {
        var encodedNumber = envelope.source + '.' + envelope.sourceDevice;
        console.log('data message from', encodedNumber, envelope.timestamp.toNumber());
        var p = Promise.resolve();
        if ((message.flags & textsecure.protobuf.DataMessage.Flags.END_SESSION) ==
                textsecure.protobuf.DataMessage.Flags.END_SESSION ) {
            p = this.handleEndSession(envelope.source);
        }
        return p.then(function() {
            return this.processDecrypted(message, envelope.source).then(function(message) {
                var ev = new Event('message');
                ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
                ev.data = {
                    source    : envelope.source,
                    timestamp : envelope.timestamp.toNumber(),
                    message   : message
                };
                this.dispatchEvent(ev);
            }.bind(this));
        }.bind(this));
    },
    handleLegacyMessage: function (envelope) {
        return this.decrypt(envelope, envelope.legacyMessage).then(function(plaintext) {
            return this.innerHandleLegacyMessage(envelope, plaintext);
        }.bind(this));
    },
    innerHandleLegacyMessage: function (envelope, plaintext) {
        var message = textsecure.protobuf.DataMessage.decode(plaintext);
        return this.handleDataMessage(envelope, message);
    },
    handleContentMessage: function (envelope) {
        return this.decrypt(envelope, envelope.content).then(function(plaintext) {
            this.innerHandleContentMessage(envelope, plaintext);
        }.bind(this));
    },
    innerHandleContentMessage: function(envelope, plaintext) {
        var content = textsecure.protobuf.Content.decode(plaintext);
        if (content.syncMessage) {
            return this.handleSyncMessage(envelope, content.syncMessage);
        } else if (content.dataMessage) {
            return this.handleDataMessage(envelope, content.dataMessage);
        } else if (content.nullMessage) {
            return this.handleNullMessage(envelope, content.nullMessage);
        } else {
            this.removeFromUnprocessed(envelope);
            throw new Error('Unsupported content message');
        }
    },
    handleNullMessage: function(envelope, nullMessage) {
        var encodedNumber = envelope.source + '.' + envelope.sourceDevice;
        console.log('null message from', encodedNumber, envelope.timestamp.toNumber());
        this.removeFromUnprocessed(envelope);
    },
    handleSyncMessage: function(envelope, syncMessage) {
        if (envelope.source !== this.number) {
            throw new Error('Received sync message from another number');
        }
        if (envelope.sourceDevice == this.deviceId) {
            throw new Error('Received sync message from our own device');
        }
        if (syncMessage.sent) {
            var sentMessage = syncMessage.sent;
            console.log('sent message to',
                    sentMessage.destination,
                    sentMessage.timestamp.toNumber(),
                    'from', envelope.source + '.' + envelope.sourceDevice
            );
            return this.handleSentMessage(
                    envelope,
                    sentMessage.destination,
                    sentMessage.timestamp,
                    sentMessage.message,
                    sentMessage.expirationStartTimestamp
            );
        } else if (syncMessage.contacts) {
            this.handleContacts(envelope, syncMessage.contacts);
        } else if (syncMessage.groups) {
            this.handleGroups(envelope, syncMessage.groups);
        } else if (syncMessage.blocked) {
            this.handleBlocked(envelope, syncMessage.blocked);
        } else if (syncMessage.request) {
            console.log('Got SyncMessage Request');
            this.removeFromUnprocessed(envelope);
        } else if (syncMessage.read && syncMessage.read.length) {
            console.log('read messages',
                    'from', envelope.source + '.' + envelope.sourceDevice);
            this.handleRead(envelope, syncMessage.read);
        } else if (syncMessage.verified) {
            this.handleVerified(envelope, syncMessage.verified);
        } else {
            throw new Error('Got empty SyncMessage');
        }
    },
    handleVerified: function(envelope, verified, options) {
        options = options || {};
        _.defaults(options, {viaContactSync: false});

        var ev = new Event('verified');
        ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
        ev.verified = {
            state: verified.state,
            destination: verified.destination,
            identityKey: verified.identityKey.toArrayBuffer()
        };
        ev.viaContactSync = options.viaContactSync;
        this.dispatchEvent(ev);
    },
    handleRead: function(envelope, read) {
        for (var i = 0; i < read.length; ++i) {
            var ev = new Event('read');
            ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
            ev.timestamp = envelope.timestamp.toNumber();
            ev.read = {
              timestamp : read[i].timestamp.toNumber(),
              sender    : read[i].sender
            }
            this.dispatchEvent(ev);
        }
    },
    handleContacts: function(envelope, contacts) {
        console.log('contact sync');
        var eventTarget = this;
        var attachmentPointer = contacts.blob;
        return this.handleAttachment(attachmentPointer).then(function() {
            var contactBuffer = new ContactBuffer(attachmentPointer.data);
            var contactDetails = contactBuffer.next();
            while (contactDetails !== undefined) {
                var ev = new Event('contact');
                ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
                ev.contactDetails = contactDetails;
                eventTarget.dispatchEvent(ev);

                if (contactDetails.verified) {
                    this.handleVerified(envelope, contactDetails.verified, {viaContactSync: true});
                }

                contactDetails = contactBuffer.next();
            }

            var ev = new Event('contactsync');
            ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
            eventTarget.dispatchEvent(ev);
        }.bind(this));
    },
    handleGroups: function(envelope, groups) {
        console.log('group sync');
        var eventTarget = this;
        var attachmentPointer = groups.blob;
        return this.handleAttachment(attachmentPointer).then(function() {
            var groupBuffer = new GroupBuffer(attachmentPointer.data);
            var groupDetails = groupBuffer.next();
            var promises = [];
            while (groupDetails !== undefined) {
                var promise = (function(groupDetails) {
                    groupDetails.id = groupDetails.id.toBinary();
                    if (groupDetails.active) {
                        return textsecure.storage.groups.getGroup(groupDetails.id).
                            then(function(existingGroup) {
                                if (existingGroup === undefined) {
                                    return textsecure.storage.groups.createNewGroup(
                                        groupDetails.members, groupDetails.id
                                    );
                                } else {
                                    return textsecure.storage.groups.updateNumbers(
                                        groupDetails.id, groupDetails.members
                                    );
                                }
                            }).then(function() { return groupDetails });
                    } else {
                        return Promise.resolve(groupDetails);
                    }
                })(groupDetails).then(function(groupDetails) {
                    var ev = new Event('group');
                    ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
                    ev.groupDetails = groupDetails;
                    eventTarget.dispatchEvent(ev);
                }).catch(function(e) {
                    console.log('error processing group', e);
                });
                groupDetails = groupBuffer.next();
                promises.push(promise);
            }

            Promise.all(promises).then(function() {
                var ev = new Event('groupsync');
                ev.confirm = this.removeFromUnprocessed.bind(this, envelope);
                eventTarget.dispatchEvent(ev);
            }.bind(this));
        }.bind(this));
    },
    handleBlocked: function(blocked) {
        textsecure.storage.put('blocked', blocked.numbers);
    },
    isBlocked: function(number) {
        return textsecure.storage.get('blocked', []).indexOf(number) >= 0;
    },
    handleAttachment: function(attachment) {
        attachment.id = attachment.id.toString();
        attachment.key = attachment.key.toArrayBuffer();
        if (attachment.digest) {
          attachment.digest = attachment.digest.toArrayBuffer();
        }
        function decryptAttachment(encrypted) {
            return textsecure.crypto.decryptAttachment(
                encrypted,
                attachment.key,
                attachment.digest
            );
        }

        function updateAttachment(data) {
            attachment.data = data;
        }

        return this.server.getAttachment(attachment.id).
        then(decryptAttachment).
        then(updateAttachment);
    },
    tryMessageAgain: function(from, ciphertext) {
        var address = libsignal.SignalProtocolAddress.fromString(from);
        var sessionCipher = new libsignal.SessionCipher(textsecure.storage.protocol, address);
        console.log('retrying prekey whisper message');
        return this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address).then(function(plaintext) {
            var finalMessage = textsecure.protobuf.DataMessage.decode(plaintext);

            var p = Promise.resolve();
            if ((finalMessage.flags & textsecure.protobuf.DataMessage.Flags.END_SESSION)
                    == textsecure.protobuf.DataMessage.Flags.END_SESSION &&
                    finalMessage.sync !== null) {
                    var number = address.getName();
                    p = this.handleEndSession(number);
            }

            return p.then(function() {
                return this.processDecrypted(finalMessage);
            }.bind(this));
        }.bind(this));
    },
    handleEndSession: function(number) {
        console.log('got end session');
        return textsecure.storage.protocol.getDeviceIds(number).then(function(deviceIds) {
            return Promise.all(deviceIds.map(function(deviceId) {
                var address = new libsignal.SignalProtocolAddress(number, deviceId);
                var sessionCipher = new libsignal.SessionCipher(textsecure.storage.protocol, address);

                console.log('closing session for', address.toString());
                return sessionCipher.closeOpenSessionForDevice();
            }));
        });
    },
    processDecrypted: function(decrypted, source) {
        // Now that its decrypted, validate the message and clean it up for consumer processing
        // Note that messages may (generally) only perform one action and we ignore remaining fields
        // after the first action.

        if (decrypted.flags == null) {
            decrypted.flags = 0;
        }
        if (decrypted.expireTimer == null) {
            decrypted.expireTimer = 0;
        }

        if (decrypted.flags & textsecure.protobuf.DataMessage.Flags.END_SESSION) {
            decrypted.body = null;
            decrypted.attachments = [];
            decrypted.group = null;
            return Promise.resolve(decrypted);
        } else if (decrypted.flags & textsecure.protobuf.DataMessage.Flags.EXPIRATION_TIMER_UPDATE ) {
            decrypted.body = null;
            decrypted.attachments = [];
        } else if (decrypted.flags != 0) {
            throw new Error("Unknown flags in message");
        }

        var promises = [];

        if (decrypted.group !== null) {
            decrypted.group.id = decrypted.group.id.toBinary();

            if (decrypted.group.type == textsecure.protobuf.GroupContext.Type.UPDATE) {
                if (decrypted.group.avatar !== null) {
                    promises.push(this.handleAttachment(decrypted.group.avatar));
                }
            }

            promises.push(textsecure.storage.groups.getNumbers(decrypted.group.id).then(function(existingGroup) {
                if (existingGroup === undefined) {
                    if (decrypted.group.type != textsecure.protobuf.GroupContext.Type.UPDATE) {
                        decrypted.group.members = [source];
                        console.log("Got message for unknown group");
                    }
                    return textsecure.storage.groups.createNewGroup(decrypted.group.members, decrypted.group.id);
                } else {
                    var fromIndex = existingGroup.indexOf(source);

                    if (fromIndex < 0) {
                        //TODO: This could be indication of a race...
                        console.log("Sender was not a member of the group they were sending from");
                    }

                    switch(decrypted.group.type) {
                    case textsecure.protobuf.GroupContext.Type.UPDATE:
                        decrypted.body = null;
                        decrypted.attachments = [];
                        return textsecure.storage.groups.updateNumbers(
                            decrypted.group.id, decrypted.group.members
                        );

                        break;
                    case textsecure.protobuf.GroupContext.Type.QUIT:
                        decrypted.body = null;
                        decrypted.attachments = [];
                        if (source === this.number) {
                            return textsecure.storage.groups.deleteGroup(decrypted.group.id);
                        } else {
                            return textsecure.storage.groups.removeNumber(decrypted.group.id, source);
                        }
                    case textsecure.protobuf.GroupContext.Type.DELIVER:
                        decrypted.group.name = null;
                        decrypted.group.members = [];
                        decrypted.group.avatar = null;

                        break;
                    default:
                        throw new Error("Unknown group message type");
                    }
                }
            }.bind(this)));
        }

        for (var i in decrypted.attachments) {
            promises.push(this.handleAttachment(decrypted.attachments[i]));
        }
        return Promise.all(promises).then(function() {
            return decrypted;
        });
    }
});

window.textsecure = window.textsecure || {};

textsecure.MessageReceiver = function(url, ports, username, password, signalingKey) {
    var messageReceiver = new MessageReceiver(url, ports, username, password, signalingKey);
    this.addEventListener    = messageReceiver.addEventListener.bind(messageReceiver);
    this.removeEventListener = messageReceiver.removeEventListener.bind(messageReceiver);
    this.getStatus           = messageReceiver.getStatus.bind(messageReceiver);
    this.close               = messageReceiver.close.bind(messageReceiver);
    messageReceiver.connect();

    textsecure.replay.registerFunction(messageReceiver.tryMessageAgain.bind(messageReceiver), textsecure.replay.Type.INIT_SESSION);
};

textsecure.MessageReceiver.prototype = {
    constructor: textsecure.MessageReceiver
};

