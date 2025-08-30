const nerdamer = require("nerdamer");
require("nerdamer/Calculus");
require("nerdamer/Solve");
const math = require("mathjs");

// solving equations
function solveEquation(match) {
  const variable = match[1];
  const leftExpression = match[2];
  const rightExpression = match[3];

  // create equation
  const equation = `${leftExpression} - (${rightExpression})`;

  // solve equation
  var solutions = 0;
  try {
    solutions = nerdamer.solve(equation, variable).toString();
  } catch {
    return "что-то пошло не так VoHiYo ";
  }
  if (!solutions || solutions === "[]") {
    return "Нет аналитического решения для этого уравнения.";
  }
  var trimmedString_sol = solutions.slice(1, -1);
  var stringArray = trimmedString_sol.split(",");
  if (stringArray.length > 4) {
    return `${variable} = ${stringArray[0]} остальные корни не поместились в сообщение `;
  }
  return `${variable} = ${solutions}`;
}

// calculator
function evaluateExpression(expression) {
  try {
    // var operators
    const allowedSymbols = {
      add: math.add,
      subtract: math.subtract,
      multiply: math.multiply,
      divide: math.divide,
      pow: math.pow,
      number: math.number,
    };

    const parser = new math.parser();
    parser.set(allowedSymbols);

    // solve equation
    const result = parser.evaluate(expression);
    return result;
  } catch (error) {
    return `Error: ${error.message} VoHiYo `;
  }
}

// !calc
function customMath(client, channel, userState, message) {
  // calculator
  var calc_expression = message.toLowerCase().match(/!calc ([0-9+\-*/^().]+)/);
  if (calc_expression) {
    client.say(
      channel,
      `@${userState["username"]} ${evaluateExpression(calc_expression[1])}`
    );
    return 1;
  }
  // equation solving
  var match = message.toLowerCase().match(/!calc ([a-zA-Z]): ?(.+) ?= ?(.+)/);
  if (match) {
    client.say(channel, `@${userState["username"]} ${solveEquation(match)}`);
    return 1;
  }
  return 0;
}
module.exports = {
  customMath: customMath,
};
