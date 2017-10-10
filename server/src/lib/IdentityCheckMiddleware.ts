
import objectPath = require("object-path");
import randomstring = require("randomstring");
import BluebirdPromise = require("bluebird");
import util = require("util");
import Exceptions = require("./Exceptions");
import fs = require("fs");
import ejs = require("ejs");
import { IUserDataStore } from "./storage/IUserDataStore";
import { Winston } from "../../types/Dependencies";
import express = require("express");
import ErrorReplies = require("./ErrorReplies");
import { ServerVariablesHandler } from "./ServerVariablesHandler";
import AuthenticationSession = require("./AuthenticationSession");

import Identity = require("../../types/Identity");
import { IdentityValidationDocument } from "./storage/IdentityValidationDocument";

const filePath = __dirname + "/../resources/email-template.ejs";
const email_template = fs.readFileSync(filePath, "utf8");

// IdentityValidator allows user to go through a identity validation process in two steps:
// - Request an operation to be performed (password reset, registration).
// - Confirm operation with email.

export interface IdentityValidable {
  challenge(): string;
  preValidationInit(req: express.Request): BluebirdPromise<Identity.Identity>;
  postValidationInit(req: express.Request): BluebirdPromise<void>;

  // Serves a page after identity check request
  preValidationResponse(req: express.Request, res: express.Response): void;
  // Serves the page if identity validated
  postValidationResponse(req: express.Request, res: express.Response): void;
  mailSubject(): string;
}

function createAndSaveToken(userid: string, challenge: string, userDataStore: IUserDataStore)
  : BluebirdPromise<string> {
  const five_minutes = 4 * 60 * 1000;
  const token = randomstring.generate({ length: 64 });
  const that = this;

  return userDataStore.produceIdentityValidationToken(userid, token, challenge, five_minutes)
    .then(function () {
      return BluebirdPromise.resolve(token);
    });
}

function consumeToken(token: string, challenge: string, userDataStore: IUserDataStore)
  : BluebirdPromise<IdentityValidationDocument> {
  return userDataStore.consumeIdentityValidationToken(token, challenge);
}

export function register(app: express.Application, pre_validation_endpoint: string,
  post_validation_endpoint: string, handler: IdentityValidable) {
  app.get(pre_validation_endpoint, get_start_validation(handler, post_validation_endpoint));
  app.get(post_validation_endpoint, get_finish_validation(handler));
}

function checkIdentityToken(req: express.Request, identityToken: string): BluebirdPromise<void> {
  if (!identityToken)
    return BluebirdPromise.reject(new Exceptions.AccessDeniedError("No identity token provided"));
  return BluebirdPromise.resolve();
}

export function get_finish_validation(handler: IdentityValidable): express.RequestHandler {
  return function (req: express.Request, res: express.Response): BluebirdPromise<void> {
    const logger = ServerVariablesHandler.getLogger(req.app);
    const userDataStore = ServerVariablesHandler.getUserDataStore(req.app);

    let authSession: AuthenticationSession.AuthenticationSession;
    const identityToken = objectPath.get<express.Request, string>(req, "query.identity_token");
    logger.debug(req, "Identity token provided is %s", identityToken);

    return checkIdentityToken(req, identityToken)
      .then(function () {
        return handler.postValidationInit(req);
      })
      .then(function () {
        return AuthenticationSession.get(req);
      })
      .then(function (_authSession: AuthenticationSession.AuthenticationSession) {
        authSession = _authSession;
      })
      .then(function () {
        return consumeToken(identityToken, handler.challenge(), userDataStore);
      })
      .then(function (doc: IdentityValidationDocument) {
        authSession.identity_check = {
          challenge: handler.challenge(),
          userid: doc.userId
        };
        handler.postValidationResponse(req, res);
        return BluebirdPromise.resolve();
      })
      .catch(ErrorReplies.replyWithError401(req, res, logger));
  };
}


export function get_start_validation(handler: IdentityValidable, postValidationEndpoint: string)
  : express.RequestHandler {
  return function (req: express.Request, res: express.Response): BluebirdPromise<void> {
    const logger = ServerVariablesHandler.getLogger(req.app);
    const notifier = ServerVariablesHandler.getNotifier(req.app);
    const userDataStore = ServerVariablesHandler.getUserDataStore(req.app);
    let identity: Identity.Identity;

    return handler.preValidationInit(req)
      .then(function (id: Identity.Identity) {
        identity = id;
        const email = identity.email;
        const userid = identity.userid;
        logger.info(req, "Start identity validation of user \"%s\"", userid);

        if (!(email && userid))
          return BluebirdPromise.reject(new Exceptions.IdentityError(
            "Missing user id or email address"));

        return createAndSaveToken(userid, handler.challenge(), userDataStore);
      })
      .then(function (token: string) {
        const host = req.get("Host");
        const link_url = util.format("https://%s%s?identity_token=%s", host,
          postValidationEndpoint, token);
        logger.info(req, "Notification sent to user \"%s\"", identity.userid);
        return notifier.notify(identity, handler.mailSubject(), link_url);
      })
      .then(function () {
        handler.preValidationResponse(req, res);
        return BluebirdPromise.resolve();
      })
      .catch(ErrorReplies.replyWithError401(req, res, logger));
  };
}
