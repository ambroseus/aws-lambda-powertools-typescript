/**
 * Test tracer manual mode
 *
 * @group e2e/tracer/manual
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { Tracing } from '@aws-cdk/aws-lambda';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import { App, Duration, Stack } from '@aws-cdk/core';
import { SdkProvider } from 'aws-cdk/lib/api/aws-auth';
import { CloudFormationDeployments } from 'aws-cdk/lib/api/cloudformation-deployments';
import * as AWS from 'aws-sdk';
import { getTraces, getInvocationSubsegment } from '../helpers/tracesUtils';
import type { ParsedDocument } from '../helpers/tracesUtils';

const xray = new AWS.XRay();
const lambdaClient = new AWS.Lambda();
const stsClient = new AWS.STS();

describe('Tracer integration tests', () => {

  const expectedCustomAnnotationKey = 'myAnnotation';
  const expectedCustomAnnotationValue = 'myValue';
  const expectedCustomMetadataKey = 'myMetadata';
  const expectedCustomMetadataValue = { bar: 'baz' };
  const expectedCustomResponseValue = { foo: 'bar' };
  const expectedCustomErrorMessage = 'An error has occurred';
  const startTime = new Date();
  const invocations = 3;

  let integTestApp: App;
  let stack: Stack;
  const invocationsMap: { [key: string]: { serviceName: string; resourceArn: string } } = {};

  beforeAll(async () => {

    // Prepare
    integTestApp = new App();
    stack = new Stack(integTestApp, 'TracerIntegTest');

    const identity = await stsClient.getCallerIdentity().promise();
    const account = identity.Account;
    const region = process.env.AWS_REGION;
    
    const functions = [
      'Manual',
      'Middleware',
      'Middleware-Disabled',
      'Middleware-NoCaptureErrorResponse',
      'Decorator',
      'DecoratorWithAsyncHandler',
      'Decorator-Disabled',
      'Decorator-NoCaptureErrorResponse',
    ];
    for (const functionName of functions) {
      const expectedServiceName = randomUUID();
      const fileName = functionName.split('-')[0];
      new NodejsFunction(stack, functionName, {
        entry: join(__dirname, `tracer.test.${fileName}.ts`),
        handler: 'handler',
        functionName: functionName,
        tracing: Tracing.ACTIVE,
        environment: {
          EXPECTED_SERVICE_NAME: expectedServiceName,
          EXPECTED_CUSTOM_ANNOTATION_KEY: expectedCustomAnnotationKey,
          EXPECTED_CUSTOM_ANNOTATION_VALUE: expectedCustomAnnotationValue,
          EXPECTED_CUSTOM_METADATA_KEY: expectedCustomMetadataKey,
          EXPECTED_CUSTOM_METADATA_VALUE: JSON.stringify(expectedCustomMetadataValue),
          EXPECTED_CUSTOM_RESPONSE_VALUE: JSON.stringify(expectedCustomResponseValue),
          EXPECTED_CUSTOM_ERROR_MESSAGE: expectedCustomErrorMessage,
          POWERTOOLS_TRACER_CAPTURE_RESPONSE: functionName.indexOf('NoCaptureErrorResponse') !== -1 ? 'false' : 'true',
          POWERTOOLS_TRACER_CAPTURE_ERROR: functionName.indexOf('NoCaptureErrorResponse') !== -1 ? 'false' : 'true',
          POWERTOOLS_TRACE_ENABLED: functionName.indexOf('Disabled') !== -1 ? 'false' : 'true',
        },
        timeout: Duration.seconds(30),
      });
      invocationsMap[functionName] = {
        serviceName: expectedServiceName,
        resourceArn: `arn:aws:lambda:${region}:${account}:function:${functionName}`, // ARN is still a token at this point, so we construct the ARN manually
      };
    }

    const stackArtifact = integTestApp.synth().getStackByName(stack.stackName);

    const sdkProvider = await SdkProvider.withAwsCliCompatibleDefaults({
      profile: process.env.AWS_PROFILE,
    });
    const cloudFormation = new CloudFormationDeployments({ sdkProvider });
    await cloudFormation.deployStack({
      stack: stackArtifact,
      quiet: true,
    });

    // Act
    Object.keys(invocationsMap).forEach(async (functionName) => {
      for (let i = 0; i < invocations; i++) {
        await lambdaClient.invoke({
          FunctionName: functionName,
          Payload: JSON.stringify({
            throw: i === invocations - 1 ? true : false, // only last invocation should throw
            sdkV2: i === 1 ? 'all' : 'client', // only second invocation should use captureAll
            invocation: i + 1, // Pass invocation number for easier debugging
          }),
        }).promise();
      }
    });
    
    // sleep to allow for traces to be collected
    await new Promise((resolve) => setTimeout(resolve, 180000));

  }, 360000); // 6 minutes

  afterAll(async () => {

    if (!process.env.DISABLE_TEARDOWN) {
      const stackArtifact = integTestApp.synth().getStackByName(stack.stackName);
  
      const sdkProvider = await SdkProvider.withAwsCliCompatibleDefaults({
        profile: process.env.AWS_PROFILE,
      });
      const cloudFormation = new CloudFormationDeployments({ sdkProvider });
  
      await cloudFormation.destroyStack({
        stack: stackArtifact,
        quiet: true,
      });
    }

  }, 180000); // 3 minutes

  it('Verifies that a when Tracer is used to manually instrument a function all custom traces are generated with correct annotations and metadata', async () => {
    
    const resourceArn = invocationsMap['Manual'].resourceArn;
    const expectedServiceName = invocationsMap['Manual'].serviceName;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(4);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        if (handlerSubsegment?.subsegments !== undefined) {
          // Assert that there're two subsegments
          expect(handlerSubsegment?.subsegments?.length).toBe(2);

          const [ AWSSDKSubsegment1, AWSSDKSubsegment2 ] = handlerSubsegment?.subsegments;
          // Assert that the subsegment names is the expected ones
          expect(AWSSDKSubsegment1.name).toBe('STS');
          expect(AWSSDKSubsegment2.name).toBe('STS');
          
          const { annotations, metadata } = handlerSubsegment;

          if (annotations !== undefined && metadata !== undefined) {
            // Assert that the annotations are as expected
            expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
            expect(annotations['Service']).toEqual(expectedServiceName);
            expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
            // Assert that the metadata object is as expected
            expect(metadata[expectedServiceName][expectedCustomMetadataKey])
              .toEqual(expectedCustomMetadataValue);
            
            if (i === invocations - 1) {
              // Assert that the subsegment has the expected fault
              expect(invocationSubsegment.error).toBe(true);
              expect(handlerSubsegment.fault).toBe(true);
              expect(handlerSubsegment.hasOwnProperty('cause')).toBe(true);
              expect(handlerSubsegment.cause?.exceptions[0].message).toBe(expectedCustomErrorMessage);
            } else {
              // Assert that the metadata object contains the response
              expect(metadata[expectedServiceName]['index.handler response'])
                .toEqual(expectedCustomResponseValue);
            }
          } else {
            // Make test fail if there are no annotations or metadata
            expect('annotations !== undefined && metadata !== undefined')
              .toBe('annotations === undefined && metadata === undefined');
          }
        } else {
          // Make test fail if the handlerSubsegment subsegment doesn't have any subsebment
          expect('handlerSubsegment?.subsegments !== undefined')
            .toBe('handlerSubsegment?.subsegments === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 120000); // 2 minutes

  it('Verifies that a when Tracer is used as middleware all custom traces are generated with correct annotations and metadata', async () => {
    
    const resourceArn = invocationsMap['Middleware'].resourceArn;
    const expectedServiceName = invocationsMap['Middleware'].serviceName;

    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(4);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        if (handlerSubsegment?.subsegments !== undefined) {
          // Assert that there're two subsegments
          expect(handlerSubsegment?.subsegments?.length).toBe(2);

          const [ AWSSDKSubsegment1, AWSSDKSubsegment2 ] = handlerSubsegment?.subsegments;
          // Assert that the subsegment names is the expected ones
          expect(AWSSDKSubsegment1.name).toBe('STS');
          expect(AWSSDKSubsegment2.name).toBe('STS');
          
          const { annotations, metadata } = handlerSubsegment;

          if (annotations !== undefined && metadata !== undefined) {
            // Assert that the annotations are as expected
            expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
            expect(annotations['Service']).toEqual(expectedServiceName);
            expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
            // Assert that the metadata object is as expected
            expect(metadata[expectedServiceName][expectedCustomMetadataKey])
              .toEqual(expectedCustomMetadataValue);
            
            if (i === invocations - 1) {
              // Assert that the subsegment has the expected fault
              expect(invocationSubsegment.error).toBe(true);
              expect(handlerSubsegment.fault).toBe(true);
              expect(handlerSubsegment.hasOwnProperty('cause')).toBe(true);
              expect(handlerSubsegment.cause?.exceptions[0].message).toBe(expectedCustomErrorMessage);
            } else {
              // Assert that the metadata object contains the response
              expect(metadata[expectedServiceName]['index.handler response'])
                .toEqual(expectedCustomResponseValue);
            }
          } else {
            // Make test fail if there are no annotations or metadata
            expect('annotations !== undefined && metadata !== undefined')
              .toBe('annotations === undefined && metadata === undefined');
          }
        } else {
          // Make test fail if the handlerSubsegment subsegment doesn't have any subsebment
          expect('handlerSubsegment?.subsegments !== undefined')
            .toBe('handlerSubsegment?.subsegments === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 120000); // 2 minutes

  it('Verifies that a when Tracer is used as middleware, with errors & response capturing disabled, all custom traces are generated with correct annotations', async () => {
    
    const resourceArn = invocationsMap['Middleware-NoCaptureErrorResponse'].resourceArn;
    const expectedServiceName = invocationsMap['Middleware-NoCaptureErrorResponse'].serviceName;

    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(4);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        if (handlerSubsegment?.subsegments !== undefined) {
          // Assert that there're two subsegments
          expect(handlerSubsegment?.subsegments?.length).toBe(2);

          const [ AWSSDKSubsegment1, AWSSDKSubsegment2 ] = handlerSubsegment?.subsegments;
          // Assert that the subsegment names is the expected ones
          expect(AWSSDKSubsegment1.name).toBe('STS');
          expect(AWSSDKSubsegment2.name).toBe('STS');
          
          const { annotations, metadata } = handlerSubsegment;

          if (annotations !== undefined && metadata !== undefined) {
            // Assert that the annotations are as expected
            expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
            expect(annotations['Service']).toEqual(expectedServiceName);
            expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
            // Assert that the metadata object is as expected
            expect(metadata[expectedServiceName][expectedCustomMetadataKey])
              .toEqual(expectedCustomMetadataValue);
            
            if (i === invocations - 1) {
              // Assert that the subsegment has the expected fault
              expect(invocationSubsegment.error).toBe(true);
              expect(handlerSubsegment.error).toBe(true);
              // Assert that no error was captured on the subsegment
              expect(handlerSubsegment.hasOwnProperty('cause')).toBe(false);
            } else {
              // Assert that the metadata object does not contain the response object
              expect(metadata[expectedServiceName].hasOwnProperty('index.handler response')).toBe(false);
            }
          } else {
            // Make test fail if there are no annotations or metadata
            expect('annotations !== undefined && metadata !== undefined')
              .toBe('annotations === undefined && metadata === undefined');
          }
        } else {
          // Make test fail if the handlerSubsegment subsegment doesn't have any subsebment
          expect('handlerSubsegment?.subsegments !== undefined')
            .toBe('handlerSubsegment?.subsegments === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 120000); // 2 minutes

  it('Verifies that a when tracing is disabled in middleware mode no custom traces are generated', async () => {
    
    const resourceArn = invocationsMap['Middleware-Disabled'].resourceArn;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(2);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      expect(invocationSubsegment?.subsegments).toBeUndefined();
         
      if (i === invocations - 1) {
        // Assert that the subsegment has the expected fault
        expect(invocationSubsegment.error).toBe(true);
      }
    }

  }, 120000); // 2 minutes

  it('Verifies that a when Tracer is used as decorator all custom traces are generated with correct annotations and metadata', async () => {
    
    const resourceArn = invocationsMap['Decorator'].resourceArn;
    const expectedServiceName = invocationsMap['Decorator'].serviceName;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(4);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        if (handlerSubsegment?.subsegments !== undefined) {
          // Assert that there're three subsegments
          expect(handlerSubsegment?.subsegments?.length).toBe(3);
          
          // Sort the subsegments by name
          const stsSubsegments: ParsedDocument[] = [];
          const methodSubsegment: ParsedDocument[] = [];
          const otherSegments: ParsedDocument[] = [];
          handlerSubsegment?.subsegments.forEach(subsegment => {
            if (subsegment.name === 'STS') {
              stsSubsegments.push(subsegment);
            } else if (subsegment.name === '### myMethod') {
              methodSubsegment.push(subsegment);
            } else {
              otherSegments.push(subsegment);
            }
          });
          // Assert that there are exactly two subsegment with the name 'STS'
          expect(stsSubsegments.length).toBe(2);
          // Assert that there is exactly one subsegment with the name '### myMethod'
          expect(methodSubsegment.length).toBe(1);
          // Assert that there are exactly zero other subsegments
          expect(otherSegments.length).toBe(0);

          const { metadata } = methodSubsegment[0];

          if (metadata !== undefined) {
            // Assert that the metadata object is as expected
            expect(metadata[expectedServiceName]['myMethod response'])
              .toEqual(expectedCustomResponseValue);
          } else {
            // Make test fail if there is no metadata
            expect('metadata !== undefined')
              .toBe('metadata === undefined');
          }
        } else {
          // Make test fail if the handlerSubsegment subsegment doesn't have any subsebment
          expect('handlerSubsegment?.subsegments !== undefined')
            .toBe('handlerSubsegment?.subsegments === undefined');
        }
        
        const { annotations, metadata } = handlerSubsegment;

        if (annotations !== undefined && metadata !== undefined) {
          // Assert that the annotations are as expected
          expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
          expect(annotations['Service']).toEqual(expectedServiceName);
          expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
          // Assert that the metadata object is as expected
          expect(metadata[expectedServiceName][expectedCustomMetadataKey])
            .toEqual(expectedCustomMetadataValue);
          
          if (i === invocations - 1) {
            // Assert that the subsegment has the expected fault
            expect(invocationSubsegment.error).toBe(true);
            expect(handlerSubsegment.fault).toBe(true);
            expect(handlerSubsegment.hasOwnProperty('cause')).toBe(true);
            expect(handlerSubsegment.cause?.exceptions[0].message).toBe(expectedCustomErrorMessage);
          } else {
            // Assert that the metadata object contains the response
            expect(metadata[expectedServiceName]['index.handler response'])
              .toEqual(expectedCustomResponseValue);
          }
        } else {
          // Make test fail if there are no annotations or metadata
          expect('annotations !== undefined && metadata !== undefined')
            .toBe('annotations === undefined && metadata === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 120000); // 2 minutes

  it('Verifies that a when Tracer is used as decorator on an async handler all custom traces are generated with correct annotations and metadata', async () => {
    
    const resourceArn = invocationsMap['DecoratorWithAsyncHandler'].resourceArn;
    const expectedServiceName = invocationsMap['DecoratorWithAsyncHandler'].serviceName;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(4);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        if (handlerSubsegment?.subsegments !== undefined) {
          // Assert that there're three subsegments
          expect(handlerSubsegment?.subsegments?.length).toBe(3);
          
          // Sort the subsegments by name
          const stsSubsegments: ParsedDocument[] = [];
          const methodSubsegment: ParsedDocument[] = [];
          const otherSegments: ParsedDocument[] = [];
          handlerSubsegment?.subsegments.forEach(subsegment => {
            if (subsegment.name === 'STS') {
              stsSubsegments.push(subsegment);
            } else if (subsegment.name === '### myMethod') {
              methodSubsegment.push(subsegment);
            } else {
              otherSegments.push(subsegment);
            }
          });
          // Assert that there are exactly two subsegment with the name 'STS'
          expect(stsSubsegments.length).toBe(2);
          // Assert that there is exactly one subsegment with the name '### myMethod'
          expect(methodSubsegment.length).toBe(1);
          // Assert that there are exactly zero other subsegments
          expect(otherSegments.length).toBe(0);

          const { metadata } = methodSubsegment[0];

          if (metadata !== undefined) {
            // Assert that the metadata object is as expected
            expect(metadata[expectedServiceName]['myMethod response'])
              .toEqual(expectedCustomResponseValue);
          } else {
            // Make test fail if there is no metadata
            expect('metadata !== undefined')
              .toBe('metadata === undefined');
          }
        } else {
          // Make test fail if the handlerSubsegment subsegment doesn't have any subsebment
          expect('handlerSubsegment?.subsegments !== undefined')
            .toBe('handlerSubsegment?.subsegments === undefined');
        }
        
        const { annotations, metadata } = handlerSubsegment;

        if (annotations !== undefined && metadata !== undefined) {
          // Assert that the annotations are as expected
          expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
          expect(annotations['Service']).toEqual(expectedServiceName);
          expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
          // Assert that the metadata object is as expected
          expect(metadata[expectedServiceName][expectedCustomMetadataKey])
            .toEqual(expectedCustomMetadataValue);
          
          if (i === invocations - 1) {
            // Assert that the subsegment has the expected fault
            expect(invocationSubsegment.error).toBe(true);
            expect(handlerSubsegment.fault).toBe(true);
            expect(handlerSubsegment.hasOwnProperty('cause')).toBe(true);
            expect(handlerSubsegment.cause?.exceptions[0].message).toBe(expectedCustomErrorMessage);
          } else {
            // Assert that the metadata object contains the response
            expect(metadata[expectedServiceName]['index.handler response'])
              .toEqual(expectedCustomResponseValue);
          }
        } else {
          // Make test fail if there are no annotations or metadata
          expect('annotations !== undefined && metadata !== undefined')
            .toBe('annotations === undefined && metadata === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 120000); // 2 minutes

  it('Verifies that a when Tracer is used as decorator, with errors & response capturing disabled, all custom traces are generated with correct annotations', async () => {
    
    const resourceArn = invocationsMap['Decorator-NoCaptureErrorResponse'].resourceArn;
    const expectedServiceName = invocationsMap['Decorator-NoCaptureErrorResponse'].serviceName;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(4);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      if (invocationSubsegment?.subsegments !== undefined) {
        expect(invocationSubsegment?.subsegments?.length).toBe(1);
        const handlerSubsegment = invocationSubsegment?.subsegments[0];
        // Assert that the subsegment name is the expected one
        expect(handlerSubsegment.name).toBe('## index.handler');
        if (handlerSubsegment?.subsegments !== undefined) {
          // Assert that there're three subsegments
          expect(handlerSubsegment?.subsegments?.length).toBe(3);
          
          // Sort the subsegments by name
          const stsSubsegments: ParsedDocument[] = [];
          const methodSubsegment: ParsedDocument[] = [];
          const otherSegments: ParsedDocument[] = [];
          handlerSubsegment?.subsegments.forEach(subsegment => {
            if (subsegment.name === 'STS') {
              stsSubsegments.push(subsegment);
            } else if (subsegment.name === '### myMethod') {
              methodSubsegment.push(subsegment);
            } else {
              otherSegments.push(subsegment);
            }
          });
          // Assert that there are exactly two subsegment with the name 'STS'
          expect(stsSubsegments.length).toBe(2);
          // Assert that there is exactly one subsegment with the name '### myMethod'
          expect(methodSubsegment.length).toBe(1);
          // Assert that there are exactly zero other subsegments
          expect(otherSegments.length).toBe(0);
          // Assert that no response was captured on the subsegment
          expect(methodSubsegment[0].hasOwnProperty('metadata')).toBe(false);
        } else {
          // Make test fail if the handlerSubsegment subsegment doesn't have any subsebment
          expect('handlerSubsegment?.subsegments !== undefined')
            .toBe('handlerSubsegment?.subsegments === undefined');
        }
        
        const { annotations, metadata } = handlerSubsegment;

        if (annotations !== undefined && metadata !== undefined) {
          // Assert that the annotations are as expected
          expect(annotations['ColdStart']).toEqual(true ? i === 0 : false);
          expect(annotations['Service']).toEqual(expectedServiceName);
          expect(annotations[expectedCustomAnnotationKey]).toEqual(expectedCustomAnnotationValue);
          // Assert that the metadata object is as expected
          expect(metadata[expectedServiceName][expectedCustomMetadataKey])
            .toEqual(expectedCustomMetadataValue);
          
          if (i === invocations - 1) {
            // Assert that the subsegment has the expected fault
            expect(invocationSubsegment.error).toBe(true);
            expect(handlerSubsegment.error).toBe(true);
            // Assert that no error was captured on the subsegment
            expect(handlerSubsegment.hasOwnProperty('cause')).toBe(false);
          } else {
            // Assert that the metadata object does not contain the response object
            expect(metadata[expectedServiceName].hasOwnProperty('index.handler response')).toBe(false);
          }
        } else {
          // Make test fail if there are no annotations or metadata
          expect('annotations !== undefined && metadata !== undefined')
            .toBe('annotations === undefined && metadata === undefined');
        }
      } else {
        // Make test fail if the Invocation subsegment doesn't have an handler subsebment
        expect('invocationSubsegment?.subsegments !== undefined')
          .toBe('invocationSubsegment?.subsegments === undefined');
      }
    }

  }, 120000); // 2 minutes

  it('Verifies that a when tracing is disabled in decorator mode no custom traces are generated', async () => {
    
    const resourceArn = invocationsMap['Decorator-Disabled'].resourceArn;
    
    // Assess
    // Retrieve traces from X-Ray using Resource ARN as filter
    const sortedTraces = await getTraces(xray, startTime, resourceArn, invocations);

    for (let i = 0; i < invocations; i++) {
      // Assert that the trace has the expected amount of segments
      expect(sortedTraces[i].Segments.length).toBe(2);

      const invocationSubsegment = getInvocationSubsegment(sortedTraces[i]);

      expect(invocationSubsegment?.subsegments).toBeUndefined();
         
      if (i === invocations - 1) {
        // Assert that the subsegment has the expected fault
        expect(invocationSubsegment.error).toBe(true);
      }
    }

  }, 120000); // 2 minutes

});
