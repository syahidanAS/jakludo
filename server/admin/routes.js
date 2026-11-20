'use strict';

const express = require('express');
const { registerAdminOverviewRoutes } = require('./overview');
const { registerAdminUserRoutes } = require('./users');
const { registerAdminRoomRoutes } = require('./rooms');
const { registerAdminFinanceRoutes } = require('./finance');

function registerAdminRoutes(api) {
  const router = express.Router();

  registerAdminOverviewRoutes(router);
  registerAdminUserRoutes(router);
  registerAdminRoomRoutes(router);
  registerAdminFinanceRoutes(router);

  api.use(router);
}

module.exports = { registerAdminRoutes };
