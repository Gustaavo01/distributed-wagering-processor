
import 'dotenv/config';

import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

import {
  createSqsClient,
  SQS_QUEUES,
} from '../src/infrastructure/messaging/sqs.service.js';

function normalizeQueueUrl(url: string): string {
  const endpoint = process.env.SQS_ENDPOINT;

  if (!endpoint) {
    return url;
  }

  const received = new URL(url);
  const configured = new URL(endpoint);

  received.protocol = configured.protocol;
  received.host = configured.host;

  return received.toString();
}

async function main(): Promise<void> {
  const client = createSqsClient();

  try {
    async function createQueue(
      queueName: string,
      deadLetterArn?: string,
    ): Promise<string> {
      const attributes: Record<string, string> = {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '60',
        ReceiveMessageWaitTimeSeconds: '5',
      };

      if (deadLetterArn) {
        attributes.RedrivePolicy = JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: 5,
        });
      }

      const response = await client.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: attributes,
        }),
      );

      if (!response.QueueUrl) {
        throw new Error(
          `Failed to create queue: ${queueName}`,
        );
      }

      const queueUrl = normalizeQueueUrl(
        response.QueueUrl,
      );

      console.log(`Queue ready: ${queueName}`);

      return queueUrl;
    }

    async function getQueueArn(
      queueUrl: string,
    ): Promise<string> {
      const response = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );

      const arn = response.Attributes?.QueueArn;

      if (!arn) {
        throw new Error(
          `Unable to retrieve queue ARN: ${queueUrl}`,
        );
      }

      return arn;
    }

    // Create dead-letter queues first.
    const transactionsDlqUrl = await createQueue(
      SQS_QUEUES.transactionsDlq,
    );

    const eventsDlqUrl = await createQueue(
      SQS_QUEUES.eventsDlq,
    );

    const transactionsDlqArn = await getQueueArn(
      transactionsDlqUrl,
    );

    const eventsDlqArn = await getQueueArn(
      eventsDlqUrl,
    );

    // Create main queues with their redrive policies.
    await createQueue(
      SQS_QUEUES.transactions,
      transactionsDlqArn,
    );

    await createQueue(
      SQS_QUEUES.events,
      eventsDlqArn,
    );

    console.log('All SQS queues are ready.');
  } finally {
    client.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error('SQS setup failed:', error);
  process.exitCode = 1;
});
