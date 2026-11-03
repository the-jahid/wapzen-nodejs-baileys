import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { User } from '../generated/prisma/client';
import { ClerkAuthGuard, CurrentUser } from '../auth/auth.guard';
import { ToolsService } from './tools.service';
import {
  apiRequestErrors,
  DEFAULT_LIST_LIMIT,
  invalidBody,
  isObject,
  LIST_PATH,
  LISTED_TOOL_TYPES,
  MAX_LIST_LIMIT,
  parseApiRequest,
  parseInput,
  systemTool,
  validateCreate,
  validateUpdate,
  validationFailed,
  type FieldError,
} from './tools.types';

// The Go server's tools API. /v1/dashboard/tools is what the dashboard calls
// with its Clerk session; /v1/tools is the public path documented in
// docs/openapi.json. Both share these handlers.
@ApiExcludeController()
@UseGuards(ClerkAuthGuard)
@Controller(['v1/tools', 'v1/dashboard/tools'])
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Get()
  async list(
    @CurrentUser() user: User,
    @Query('page') rawPage?: string,
    @Query('limit') rawLimit?: string,
    @Query('type') rawType?: string,
  ) {
    const errors: FieldError[] = [];
    const page = parsePositive(rawPage, 1);
    if (page === null) {
      errors.push({
        field: 'page',
        message: 'page must be a positive integer',
      });
    }
    const limit = parsePositive(rawLimit, DEFAULT_LIST_LIMIT);
    if (limit === null || limit > MAX_LIST_LIMIT) {
      errors.push({
        field: 'limit',
        message: `limit must be between 1 and ${MAX_LIST_LIMIT}`,
      });
    }
    const type = rawType?.trim() ?? '';
    if (type && !LISTED_TOOL_TYPES.includes(type)) {
      errors.push({
        field: 'type',
        message: `type must be one of ${LISTED_TOOL_TYPES.join(', ')}`,
      });
    }
    if (page === null || limit === null || errors.length) {
      throw validationFailed(errors, 'Invalid query parameters');
    }

    const { tools, total } = await this.tools.list(user.id, type, page, limit);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    // A filtered collection pages as filtered.
    const filter = type ? `&type=${encodeURIComponent(type)}` : '';
    const at = (p: number) => `${LIST_PATH}?page=${p}&limit=${limit}${filter}`;
    return {
      success: true,
      message: 'Tools retrieved successfully',
      data: tools,
      meta: {
        pagination: {
          page,
          limit,
          total_items: total,
          total_pages: totalPages,
          has_next_page: page < totalPages,
          has_previous_page: page > 1,
        },
      },
      links: {
        self: at(page),
        first: at(1),
        previous: page > 1 ? at(page - 1) : null,
        next: page < totalPages ? at(page + 1) : null,
        last: at(totalPages),
      },
    };
  }

  @Post()
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    const input = parseInput(body);
    const errors = validateCreate(input);
    if (errors.length) throw validationFailed(errors);
    const data = await this.tools.create(user.id, input);
    return envelope('Tool created successfully', data);
  }

  @Get(':tool_id')
  async get(@CurrentUser() user: User, @Param('tool_id') id: string) {
    const data = await this.tools.get(user.id, id.trim());
    return envelope('Tool retrieved successfully', data);
  }

  @Patch(':tool_id')
  async update(
    @CurrentUser() user: User,
    @Param('tool_id') id: string,
    @Body() body: unknown,
  ) {
    id = id.trim();
    const input = parseInput(body);
    // The stored type decides which block the update may carry, so the tool
    // is read before the input is judged; a missing one is a 404 either way.
    const current = await this.tools.resolved(user.id, id);
    if (current.isSystem) throw systemTool();
    const errors = validateUpdate(input, current.type, current.name);
    if (errors.length) throw validationFailed(errors);
    const data = await this.tools.update(user.id, id, current.type, input);
    return envelope('Tool updated successfully', data);
  }

  @Delete(':tool_id')
  @HttpCode(200)
  async remove(@CurrentUser() user: User, @Param('tool_id') id: string) {
    id = id.trim();
    await this.tools.remove(user.id, id);
    return {
      success: true,
      message: 'Tool deleted successfully',
      data: { id, deleted: true },
    };
  }

  // A failed request is still a 200: data.ok and data.error say how it went.
  @Post(':tool_id/test')
  @HttpCode(200)
  async test(
    @CurrentUser() user: User,
    @Param('tool_id') id: string,
    @Body() body: unknown,
  ) {
    // An empty body tests the stored tool with no arguments.
    const b = body === undefined || body === null ? {} : body;
    if (!isObject(b)) throw invalidBody();
    if (b.arguments != null && !isObject(b.arguments)) throw invalidBody();
    const args = b.arguments ?? {};

    const draft =
      b.api_request == null ? undefined : parseApiRequest(b.api_request);
    if (draft) {
      const errors = apiRequestErrors(draft);
      if (errors.length) throw validationFailed(errors);
    }
    const data = await this.tools.test(user.id, id.trim(), args, draft);
    return { success: true, message: 'Tool test completed', data };
  }
}

function envelope(message: string, data: { id: string }) {
  return {
    success: true,
    message,
    data,
    links: { self: `${LIST_PATH}/${data.id}` },
  };
}

// The query value as a positive integer, fallback when absent, null when it
// isn't one.
function parsePositive(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
