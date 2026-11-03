// memoryStorage.js

import { logger } from './logger.js';
import fs from 'fs';
import path from 'path';

class MemoryStorage {
    constructor() {
        this.data = new Map();
        this.expirationTimes = new Map();
        this.storageDir = path.join(process.cwd(), 'data');
        this.storageFile = path.join(this.storageDir, 'local_storage.json');
        this._saveTimer = null;
        this._loadFromDisk();
    }

    _loadFromDisk() {
        try {
            if (fs.existsSync(this.storageFile)) {
                const raw = fs.readFileSync(this.storageFile, 'utf8');
                if (raw && raw.trim()) {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') {
                        let count = 0;
                        for (const [key, val] of Object.entries(parsed)) {
                            this.data.set(key, val);
                            count++;
                        }
                        logger.info(`Loaded ${count} records from local fallback storage (${this.storageFile})`);
                    }
                }
            }
        } catch (err) {
            logger.warn('Failed to load local fallback storage:', err.message);
        }
    }

    _scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                if (!fs.existsSync(this.storageDir)) {
                    fs.mkdirSync(this.storageDir, { recursive: true });
                }
                const obj = {};
                for (const [key, val] of this.data.entries()) {
                    if (this.expirationTimes.has(key) && Date.now() > this.expirationTimes.get(key)) {
                        continue;
                    }
                    obj[key] = val;
                }
                fs.writeFileSync(this.storageFile, JSON.stringify(obj, null, 2), 'utf8');
            } catch (err) {
                logger.warn('Failed to persist local storage to disk:', err.message);
            }
        }, 300).unref();
    }

    async get(key, defaultValue = null) {
        const value = this.data.get(key);
        
        if (this.expirationTimes.has(key)) {
            const expirationTime = this.expirationTimes.get(key);
            if (Date.now() > expirationTime) {
                this.data.delete(key);
                this.expirationTimes.delete(key);
                this._scheduleSave();
                return defaultValue;
            }
        }
        
        return value !== undefined ? value : defaultValue;
    }

    async set(key, value, ttl = null) {
        this.data.set(key, value);
        
        if (ttl && ttl > 0) {
            this.expirationTimes.set(key, Date.now() + (ttl * 1000));
        } else {
            this.expirationTimes.delete(key);
        }
        
        this._scheduleSave();
        return true;
    }

    async delete(key) {
        this.data.delete(key);
        this.expirationTimes.delete(key);
        this._scheduleSave();
        return true;
    }

    async list(prefix) {
        const keys = [];
        for (const key of this.data.keys()) {
            if (key.startsWith(prefix)) {
                if (this.expirationTimes.has(key)) {
                    const expirationTime = this.expirationTimes.get(key);
                    if (Date.now() > expirationTime) {
                        this.data.delete(key);
                        this.expirationTimes.delete(key);
                        continue;
                    }
                }
                keys.push(key);
            }
        }
        return keys;
    }

    async exists(key) {
        const value = this.data.get(key);
        
        if (this.expirationTimes.has(key)) {
            const expirationTime = this.expirationTimes.get(key);
            if (Date.now() > expirationTime) {
                this.data.delete(key);
                this.expirationTimes.delete(key);
                this._scheduleSave();
                return false;
            }
        }
        
        return value !== undefined;
    }

    async increment(key, amount = 1) {
        const current = await this.get(key, 0);
        const newValue = current + amount;
        await this.set(key, newValue);
        return newValue;
    }

    async decrement(key, amount = 1) {
        const current = await this.get(key, 0);
        const newValue = current - amount;
        await this.set(key, newValue);
        return newValue;
    }

    async clear() {
        this.data.clear();
        this.expirationTimes.clear();
        this._scheduleSave();
        return true;
    }
}

export { MemoryStorage };
