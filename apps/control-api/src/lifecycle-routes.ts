import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AuthorizationError,
  LifecycleRepository,
  type SessionPrincipal,
} from '@boss-forge/data';
import {
  recruitmentDeliverySchema,
  recruitmentInterviewActionSchema as interviewAction,
  recruitmentOnboardingActionSchema as onboardingAction,
  lifecycleRequestIdSchema,
  lifecycleOffsetSchema,
  isLifecycleInputError,
} from '@boss-forge/contracts';

export async function lifecycleRoutes(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  principal: SessionPrincipal;
  repository: LifecycleRepository;
  readJson(request: IncomingMessage): Promise<Record<string, unknown>>;
  send(response: ServerResponse, status: number, body: unknown): void;
}): Promise<boolean> {
  const { request, response, url, principal, repository, send } = input;
  if (!url.pathname.startsWith('/api/recruitment/lifecycle')) return false;
  try {
    if (
      request.method === 'GET' &&
      url.pathname === '/api/recruitment/lifecycle/context'
    ) {
      const conversationId = url.searchParams.get('conversationId'),
        stateId = url.searchParams.get('stateId');
      if (conversationId) lifecycleRequestIdSchema.parse(conversationId);
      if (stateId) lifecycleRequestIdSchema.parse(stateId);
      send(
        response,
        200,
        await repository.context(principal, {
          ...(conversationId ? { conversationId } : {}),
          ...(stateId ? { stateId } : {}),
        }),
      );
      return true;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/api/recruitment/lifecycle'
    ) {
      const offset = lifecycleOffsetSchema.parse(
        url.searchParams.get('offset') ?? 0,
      );
      send(
        response,
        200,
        await repository.workspace(principal, {
          search: url.searchParams.get('search') ?? '',
          ...(url.searchParams.get('stage')
            ? { stage: url.searchParams.get('stage')! }
            : {}),
          offset,
        }),
      );
      return true;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/recruitment/lifecycle'
    ) {
      send(
        response,
        201,
        await repository.create(principal, await input.readJson(request)),
      );
      return true;
    }
    const match = url.pathname.match(
      /^\/api\/recruitment\/lifecycle\/([0-9a-f-]+)(?:\/(interviews|offers|delivery|onboarding)(?:\/([0-9a-f-]+))?)?$/i,
    );
    if (
      !match ||
      !lifecycleRequestIdSchema.safeParse(match[1]).success ||
      (match[3] && !lifecycleRequestIdSchema.safeParse(match[3]).success)
    ) {
      send(response, 404, { message: '招聘流程接口不存在。' });
      return true;
    }
    const id = match[1]!,
      kind = match[2],
      recordId = match[3];
    let value: unknown;
    if (request.method === 'GET' && !kind)
      value = await repository.detail(principal, id);
    else if (request.method === 'PATCH' && !kind)
      value = await repository.update(
        principal,
        id,
        await input.readJson(request),
      );
    else if (request.method === 'POST') {
      const body = await input.readJson(request);
      if (kind === 'interviews')
        value = recordId
          ? await repository.interview(
              principal,
              id,
              recordId,
              interviewAction.parse(body),
            )
          : await repository.schedule(principal, id, body);
      else if (kind === 'offers')
        value = recordId
          ? await repository.offer(principal, id, recordId, body)
          : await repository.createOffer(principal, id, body);
      else if (kind === 'onboarding' && !recordId)
        value = await repository.onboarding(
          principal,
          id,
          onboardingAction.parse(body),
        );
      else if (kind === 'delivery' && !recordId)
        value = await repository.delivery(
          principal,
          id,
          recruitmentDeliverySchema.parse(body),
        );
      else {
        send(response, 404, { message: '招聘流程接口不存在。' });
        return true;
      }
    } else {
      send(response, 405, { message: '不支持此操作。' });
      return true;
    }
    send(response, 200, value);
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    send(response, isLifecycleInputError(error) ? 400 : 409, {
      message: isLifecycleInputError(error)
        ? '请检查填写内容、日期和必填项。'
        : error instanceof Error
          ? error.message
          : '操作失败，请重试。',
    });
    return true;
  }
}
