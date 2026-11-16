"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPool = getPool;
const cloud_sql_connector_1 = require("@google-cloud/cloud-sql-connector");
const pg_1 = __importDefault(require("pg"));
const { Pool } = pg_1.default;
let poolPromise;
let connector;
function getPool() {
    if (!poolPromise) {
        poolPromise = createPool();
    }
    return poolPromise;
}
async function createPool() {
    const instanceConnectionName = process.env.DATABASE_INSTANCE_CONNECTION_NAME;
    const user = process.env.DATABASE_USER;
    const password = process.env.DATABASE_PASSWORD;
    const database = process.env.DATABASE_NAME;
    if (!instanceConnectionName || !user || !password || !database) {
        throw new Error('Cloud SQL connection settings are not configured.');
    }
    connector = new cloud_sql_connector_1.Connector();
    const options = await connector.getOptions({ instanceConnectionName, ipType: cloud_sql_connector_1.IpAddressTypes.PUBLIC });
    const pool = new Pool({
        ...options,
        user,
        password,
        database,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (error) => console.error('Unexpected idle PostgreSQL client error', error));
    return pool;
}
