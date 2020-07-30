const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const { DynamoDB } = require('aws-sdk');

const messageSearches = {
  ISSUE_CHALLENGE: /challenge\s<@([^>]*)>/g,
  CHALLENGE: /<@([^>]*)>\+challenged\+<@([^>]*)>/g,
  ENTER_LOSS: /lost\sto\s<@([^>]*)>/g,
  SCORE: /(\d+)\s?[-–—]\s?(\d+)/g,
};

class SlackAuthError extends Error {
  constructor() {
    super('Slack authorisation falied.');
  }
}

const checkSlackSignature = async (event) => {
  const [apiVersion, slackSignature] = event.headers['X-Slack-Signature'].split('=');
  const requestTimestamp = event.headers['X-Slack-Request-Timestamp'];
  const hmac = crypto.createHmac('sha256', process.env.slackSigningSecret);

  hmac.update(`${apiVersion}:${requestTimestamp}:${event.body}`);

  const hash = hmac.digest('hex');

  if (hash !== slackSignature) {
    throw new SlackAuthError();
  }

  return hash;
};

module.exports.events = async (event) => {
  try {
    await checkSlackSignature(event);
  } catch (error) {
    if (error instanceof SlackAuthError) {
      return {
        statusCode: 403,
        body: error.message,
      };
    }
    return {
      statusCode: 500,
      body: 'I don’t know!',
    };
  }

  const body = JSON.parse(event.body);
  if (body.type === 'url_verification') {
    return {
      statusCode: 200,
      body: body.challenge,
    };
  }

  const slack = new WebClient(process.env.slackBotUserToken);
  const bot = body.authed_users[0];

  const issueChallengeRegex = messageSearches.ISSUE_CHALLENGE.exec(body.event.text);
  const enterLossRegex = messageSearches.ENTER_LOSS.exec(body.event.text);

  if (issueChallengeRegex) {
    const [, challengee] = issueChallengeRegex;
    const challenger = body.event.user;

    if (challengee === bot) {
      await slack.chat.postMessage({
        text: `<@${challenger}> tried to challenge a bot :robot_face:`,
        channel: body.event.channel,
      });
    } else if (challenger === challengee) {
      await slack.chat.postMessage({
        text: `<@${challenger}> is feeling lonely :sob:`,
        channel: body.event.channel,
      });
    } else {
      const dynamodb = new DynamoDB.DocumentClient({ apiVersion: '2012-08-10' });

      try {
        await dynamodb.put({
          TableName: 'challenges',
          Item: {
            channelId: body.event.channel,
            challengerId: challenger,
            challengeeId: challengee,
          },
          ConditionExpression: 'challengerId <> :challenger',
          ExpressionAttributeValues: {
            ':challenger': challenger,
          },
        }).promise();
        await Promise.all([
          slack.chat.postMessage({
            text: `<@${challenger}> challenged <@${challengee}> to a game!`,
            channel: body.event.channel,
          }),
          slack.chat.postEphemeral({
            text: `Accept <@${challenger}>’s challenge?`,
            channel: body.event.channel,
            user: challengee,
            attachments: [
              {
                callback_id: 'tender_button',
                attachment_type: 'default',
                fallback: 'Oops! Something went wrong.',
                actions: [
                  {
                    name: 'accept',
                    text: 'Accept',
                    type: 'button',
                    style: 'primary',
                    value: challenger,
                  },
                  {
                    name: 'decline',
                    text: 'Decline',
                    type: 'button',
                    style: 'default',
                    value: challenger,
                  },
                ],
              },
            ],
          }),
        ]);

        return {
          statusCode: 200,
        };
      } catch (error) {
        await slack.chat.postEphemeral({
          user: challenger,
          text: 'You have already made a pending challenge!',
          channel: body.event.channel,
        });
      }
    }
  }
  if (enterLossRegex) {
    const dynamodb = new DynamoDB.DocumentClient({ apiVersion: '2012-08-10' });
    const [, victor] = enterLossRegex;
    const loser = body.event.user;
    const scoreRegex = messageSearches.SCORE.exec(body.event.text);
    if (scoreRegex) {
      const [, score1, score2] = scoreRegex;

      if (score1 === score2) {
        await slack.chat.postMessage({
          text: `<@${loser}> and <@${victor}> drew ${score1} all!`,
          channel: body.event.channel,
        });
        return {
          statusCode: 200,
        };
      }
      const losingScore = Math.min(score1, score2);
      const winningScore = Math.max(score1, score2);
      await dynamodb.put({
        TableName: 'scores',
        Item: {
          channelId: body.event.channel,
          victorId: challenger,
          challengeeId: challengee,
        },
        ConditionExpression: 'challengerId <> :challenger',
        ExpressionAttributeValues: {
          ':challenger': challenger,
        },
      }).promise();
      await slack.chat.postMessage({
        text: `<@${loser}> lost to <@${victor}> ${losingScore} – ${winningScore}!`,
        channel: body.event.channel,
      });

      return {
        statusCode: 200,
      };
    }

    await slack.chat.postMessage({
      text: `<@${loser}> lost (just in general)`,
      channel: body.event.channel,
    });
    return {
      statusCode: 200,
    };
  }

  return {
    statusCode: 500,
  };
};

module.exports.interactions = async (event) => {
  try {
    await checkSlackSignature(event);
  } catch (error) {
    if (error instanceof SlackAuthError) {
      return {
        statusCode: 403,
        body: error.message,
      };
    }
    return {
      statusCode: 500,
      body: 'Error while authenticating Slack request',
    };
  }

  const decoded = decodeURIComponent(event.body);
  const jsonString = decoded.replace('payload=', '');
  const body = JSON.parse(jsonString);
  const interactor = body.user.id;
  const originalChallenger = body.actions[0].value;

  try {
    const dynamodb = new DynamoDB.DocumentClient({ apiVersion: '2012-08-10' });
    const challenge = await dynamodb.get({
      TableName: 'challenges',
      Key: {
        channelId: body.channel.id,
        challengerId: originalChallenger,
      },
    }).promise();

    if (['accept', 'decline'].includes(body.actions[0].name)) {
      if (challenge.Item) {
        const slack = new WebClient(process.env.slackBotUserToken);
        const { challengerId, challengeeId } = challenge.Item;
        const action = body.actions[0].name === 'accept' ? 'accepted' : 'declined';

        if (interactor === challengeeId) {
          await dynamodb.update({
            TableName: 'challenges',
            Key: {
              channelId: body.channel.id,
              challengerId: originalChallenger,
            },
            UpdateExpression: 'set accepterId = :interactorId',
            ConditionExpression: 'attribute_not_exists(accepterId)',
            ExpressionAttributeValues: {
              ':interactorId': interactor,
            },
          }).promise();
          await slack.chat.postMessage({
            channel: body.channel.id,
            text: `<@${challengeeId}> ${action} <@${challengerId}>’s challenge`,
          });
          return {
            statusCode: 200,
            body: `You ${action} <@${challengerId}>’s challenge`,
          };
        }

        await slack.chat.postEphemeral({
          user: interactor,
          text: `You can’t ${body.actions[0].name} someone else’s challenge!`,
          channel: body.channel.id,
        });
        return {
          statusCode: 403,
        };
      }
    }
  } catch (error) {
    console.log(error);
    return {
      statusCode: 400,
    };
  }

  return {
    statusCode: 500,
    body: 'See I dunno haha.',
  };
};
