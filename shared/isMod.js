const isMod = (userState) => {
  if (!userState["badges"]) {
    return false;
  }
  if (
    "moderator" in userState["badges"] ||
    "broadcaster" in userState["badges"]||
    "lead_moderator" in userState["badges"]
  ) {
    return true;
  }
  return false;
};
exports.isMod = isMod;
