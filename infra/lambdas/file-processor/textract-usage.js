"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TextractUsageTracker = void 0;
const client_rds_data_1 = require("@aws-sdk/client-rds-data");
const rdsClient = new client_rds_data_1.RDSDataClient({});
class TextractUsageTracker {
    dbArn;
    secretArn;
    dbName;
    monthlyLimit = 1000; // Free tier limit
    constructor(dbArn, secretArn, dbName = 'aistudio') {
        this.dbArn = dbArn;
        this.secretArn = secretArn;
        this.dbName = dbName;
    }
    async canProcessPages(pageCount) {
        const currentUsage = await this.getMonthlyUsage();
        return (currentUsage + pageCount) <= this.monthlyLimit;
    }
    async recordUsage(pageCount) {
        const sql = `
      INSERT INTO textract_usage (month, page_count, created_at)
      VALUES (DATE_TRUNC('month', CURRENT_DATE), :pageCount, CURRENT_TIMESTAMP)
      ON CONFLICT (month) 
      DO UPDATE SET 
        page_count = textract_usage.page_count + :pageCount,
        updated_at = CURRENT_TIMESTAMP
    `;
        await rdsClient.send(new client_rds_data_1.ExecuteStatementCommand({
            resourceArn: this.dbArn,
            secretArn: this.secretArn,
            database: this.dbName,
            sql,
            parameters: [
                { name: 'pageCount', value: { longValue: pageCount } }
            ]
        }));
    }
    async getMonthlyUsage() {
        const sql = `
      SELECT COALESCE(page_count, 0) as usage
      FROM textract_usage
      WHERE month = DATE_TRUNC('month', CURRENT_DATE)
    `;
        const result = await rdsClient.send(new client_rds_data_1.ExecuteStatementCommand({
            resourceArn: this.dbArn,
            secretArn: this.secretArn,
            database: this.dbName,
            sql
        }));
        if (result.records && result.records.length > 0) {
            return result.records[0][0]?.longValue || 0;
        }
        return 0;
    }
    async getRemainingPages() {
        const usage = await this.getMonthlyUsage();
        return Math.max(0, this.monthlyLimit - usage);
    }
}
exports.TextractUsageTracker = TextractUsageTracker;
