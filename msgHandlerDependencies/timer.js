const isTimerReady = (lastUpdate, deltaT) => {
  var curTime = new Date().getTime();
  return curTime - lastUpdate > deltaT;
};

exports.isTimerReady = isTimerReady;
