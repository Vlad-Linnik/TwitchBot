const fs = require("fs");

class UserStatsHandler {
  constructor(fileName) {
    this.fileName = fileName;
    this.data = this.downloadFromFile();
  }

  downloadFromFile() {
    if (fs.existsSync(this.fileName)) {
      const jsonData = fs.readFileSync(this.fileName);
      return JSON.parse(jsonData);
    }
    return {};
  }

  updateFile() {
    fs.writeFileSync(this.fileName, JSON.stringify(this.data, null, 2));
  }

  addUser(name) {
    if (!(name in this.data)) {
      this.data[name] = {
        win: 0,
        los: 0,
        draw: 0,
        ban_sent_t: 0,
        ban_rec_t: 0,
      };
      this.updateFile();
    }
  }

  incrementStat(name, stat) {
    if (!this.data[name]) {
      this.addUser(name);
    }
    if (["win", "los", "draw"].includes(stat)) {
      this.data[name][stat] += 1;
      this.updateFile();
    }
  }

  incrementBanStat(name, stat, value) {
    if (!this.data[name]) {
      this.addUser(name);
    }
    if (["ban_sent_t", "ban_rec_t"].includes(stat)) {
      this.data[name][stat] += value;
      this.updateFile();
    }
  }

  getUserStats(username) {
    if (this.isUserExist(username)) {
      return this.data[username];
    }
    return null;
  }

  // get top 3 of user of stats table
  getTopStats(stat) {
    if (!["win", "los", "draw", "ban_sent_t", "ban_rec_t"].includes(stat)) {
      return [];
    }
    const sortedUsers = Object.entries(this.data)
      .sort(([, a], [, b]) => b[stat] - a[stat])
      .slice(0, 3);

    return sortedUsers.map(([name, stats]) => ({ name, value: stats[stat] }));
  }

  isUserExist(name) {
    return Boolean(name in this.data);
  }
}

module.exports = {
  UserStatsHandler: UserStatsHandler,
};
