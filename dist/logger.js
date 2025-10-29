"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const logger = (...argv) => {
    const date = new Date();
    const dateStrang = `%c [worker INFO ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}:${date.getMilliseconds()}]`;
    return console.log(dateStrang, 'color: #6f4de7ff', ...argv);
};
exports.logger = logger;
