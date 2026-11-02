import * as core from '@actions/core'
import {glob} from 'glob/raw'
import * as fs from 'fs'
import * as parser from 'xml-js'
import * as pathHelper from 'path'
import {applyTransformer, removePrefix} from './utils.js'

export interface ActualTestResult {
  name: string
  totalCount: number
  skippedCount: number
  failedCount: number
  passedCount: number
  retriedCount: number
  flakyCount: number
  time: number
  annotations: Annotation[]
  globalAnnotations: Annotation[]
  testResults: ActualTestResult[]
}

interface TestCasesResult {
  totalCount: number
  skippedCount: number
  failedCount: number
  passedCount: number
  retriedCount: number
  flakyCount: number
  time: number
  annotations: Annotation[]
}

type TestCaseIssue = {
  _attributes?: {
    message?: string
    file?: string
    line?: string
  }
  _cdata?: string
  _text?: string
}

export interface TestResult {
  checkName: string
  summary: string
  totalCount: number
  skipped: number
  failed: number
  passed: number
  retried: number
  flaky: number
  time: number
  foundFiles: number
  globalAnnotations: Annotation[]
  testResults: ActualTestResult[]
}

export interface Annotation {
  path: string
  start_line: number
  end_line: number
  start_column: number
  end_column: number
  retries: number
  annotation_level: 'failure' | 'notice' | 'warning'
  status: 'success' | 'failure' | 'skipped'
  title: string
  message: string
  raw_details: string
  time: number
}

export interface Position {
  fileName: string
  line: number
}

export interface Transformer {
  searchValue: string
  replaceValue: string
  regex?: RegExp
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L6
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function resolveFileAndLine(
  file: string | null,
  line: string | null,
  className: string,
  output: string
): Promise<Position> {
  let fileName = file ? file : className.split('.').slice(-1)[0]
  const lineNumber = safeParseInt(line)
  try {
    if (fileName && lineNumber) {
      return {fileName, line: lineNumber}
    }

    const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('::', '/') // Rust test output contains colons between package names - See: https://github.com/mikepenz/action-junit-report/pull/359

    const matches = output.match(new RegExp(` [^ ]*${escapedFileName}.*?:\\d+`, 'g'))
    if (!matches) return {fileName, line: lineNumber || 1}

    const [lastItem] = matches.slice(-1)
    const lineTokens = lastItem.split(':')
    line = lineTokens.pop() || '0'

    // check, if the error message is from a rust file -- this way we have the chance to find
    // out the involved test file
    // See: https://github.com/mikepenz/action-junit-report/pull/360
    {
      const lineNumberPrefix = lineTokens.pop() || ''
      if (lineNumberPrefix.endsWith('.rs')) {
        fileName = lineNumberPrefix.split(' ').pop() || ''
      }
    }

    core.debug(`Resolved file ${fileName} and line ${line}`)

    return {fileName, line: safeParseInt(line) || -1}
  } catch (error: unknown) {
    core.warning(`⚠️ Failed to resolve file (${file}) and/or line (${line}) for ${className} (${error})`)
    return {fileName, line: safeParseInt(line) || -1}
  }
}

/**
 * Parse the provided string line number, and return its value, or null if it is not available or NaN.
 */
function safeParseInt(line: string | null): number | null {
  if (!line) return null
  const parsed = parseInt(line)
  if (isNaN(parsed)) return null
  return parsed
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L18
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
const resolvePathCache: {[key: string]: string} = {}

/**
 * Resolves the path of a given file, optionally following symbolic links.
 *
 * @param {string} workspace - The optional workspace directory.
 * @param {string} transformedFileName - The transformed file name to find.
 * @param {string[]} excludeSources - List of source paths to exclude.
 * @param {boolean} [followSymlink=false] - Whether to follow symbolic links.
 * @returns {Promise<string>} - The resolved file path.
 */
export async function resolvePath(
  workspace: string,
  transformedFileName: string,
  excludeSources: string[],
  followSymlink = false
): Promise<string> {
  const fileName: string = removePrefix(transformedFileName, workspace)
  if (resolvePathCache[fileName]) {
    return resolvePathCache[fileName]
  }

  let workspacePath: string
  if (workspace.length === 0 || workspace.endsWith('/')) {
    workspacePath = workspace
  } else {
    workspacePath = `${workspace}/`
  }

  core.debug(`Resolving path for ${fileName} in ${workspacePath}`)
  const normalizedFilename = fileName.replace(/^\.\//, '') // strip relative prefix (./)
  const globPattern = `${workspacePath}**/${normalizedFilename}.*`
  const results = await glob(globPattern, {
    follow: followSymlink
  })

  for (const result of results) {
    const absolutePath = pathHelper.resolve(result)
    core.debug(`Matched file: ${absolutePath}`)

    const found = excludeSources.find(v => absolutePath.includes(v))
    if (!found) {
      const searchPath = pathHelper.resolve(workspacePath || '.')
      const path = pathHelper.relative(searchPath, absolutePath)
      core.debug(`Resolved path: ${path}`)
      resolvePathCache[fileName] = path
      return path
    }
  }
  resolvePathCache[fileName] = normalizedFilename
  return normalizedFilename
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L43
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function parseFile(
  file: string,
  suiteRegex = '', // no-op
  includePassed = false,
  annotateNotice = false,
  checkRetries = false,
  excludeSources: string[] = ['/build/', '/__pycache__/', '/node_modules/'],
  checkTitleTemplate: string | undefined = undefined,
  breadCrumbDelimiter = '/',
  testFilesPrefix = '',
  transformer: Transformer[] = [],
  followSymlink = false,
  annotationsLimit = -1,
  truncateStackTraces = true,
  failOnParseError = false,
  globalAnnotations: Annotation[] = [],
  resolveIgnoreClassname = false,
  annotateFlaky = false
): Promise<ActualTestResult | undefined> {
  core.debug(`Parsing file ${file}`)

  const data: string = fs.readFileSync(file, 'utf8')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let report: any
  try {
    report = JSON.parse(parser.xml2json(data, {compact: true}))
  } catch (error) {
    core.error(`⚠️ Failed to parse file (${file}) with error ${error}`)
    if (failOnParseError) throw Error(`⚠️ Failed to parse file (${file}) with error ${error}`)
    return undefined
  }

  // parse child test suites
  const testsuite = report.testsuites ? report.testsuites : report.testsuite

  if (!testsuite) {
    core.error(`⚠️ Failed to retrieve root test suite from file (${file})`)
    return undefined
  }

  const testResult = await parseSuite(
    testsuite,
    suiteRegex, // no-op
    '',
    breadCrumbDelimiter,
    includePassed,
    annotateNotice,
    checkRetries,
    excludeSources,
    checkTitleTemplate,
    testFilesPrefix,
    transformer,
    followSymlink,
    annotationsLimit,
    truncateStackTraces,
    globalAnnotations,
    resolveIgnoreClassname,
    annotateFlaky
  )

  if (testResult !== undefined && !testResult.name) {
    testResult.name = pathHelper.basename(file)
  }

  return testResult
}

function templateVar(varName: string): string {
  return `{{${varName}}}`
}

async function parseSuite(
  /* eslint-disable  @typescript-eslint/no-explicit-any */
  suite: any,
  suiteRegex: string, // no-op
  breadCrumb: string,
  breadCrumbDelimiter = '/',
  includePassed = false,
  annotateNotice = false,
  checkRetries = false,
  excludeSources: string[],
  checkTitleTemplate: string | undefined = undefined,
  testFilesPrefix = '',
  transformer: Transformer[],
  followSymlink: boolean,
  annotationsLimit: number,
  truncateStackTraces: boolean,
  globalAnnotations: Annotation[],
  resolveIgnoreClassname = false,
  annotateFlaky = false
): Promise<ActualTestResult | undefined> {
  if (!suite) {
    // not a valid suite, return fast
    return undefined
  }

  let suiteName = ''
  if (suite._attributes && suite._attributes.name) {
    suiteName = suite._attributes.name
  }

  let totalCount = 0
  let skippedCount = 0
  let failedCount = 0
  let passedCount = 0
  let retriedCount = 0
  let flakyCount = 0
  let time = 0
  const annotations: Annotation[] = []

  // parse testCases
  if (suite.testcase) {
    const testcases = Array.isArray(suite.testcase) ? suite.testcase : suite.testcase ? [suite.testcase] : []
    const suiteFile = suite._attributes !== undefined ? suite._attributes.file : null
    const suiteLine = suite._attributes !== undefined ? suite._attributes.line : null
    const limit = annotationsLimit >= 0 ? annotationsLimit - globalAnnotations.length : annotationsLimit
    const parsedTestCases = await parseTestCases(
      suiteName,
      suiteFile,
      suiteLine,
      breadCrumb,
      testcases,
      includePassed,
      annotateNotice,
      checkRetries,
      excludeSources,
      checkTitleTemplate,
      testFilesPrefix,
      transformer,
      followSymlink,
      truncateStackTraces,
      limit,
      resolveIgnoreClassname,
      annotateFlaky
    )

    // expand global annotations array
    totalCount += parsedTestCases.totalCount
    skippedCount += parsedTestCases.skippedCount
    failedCount += parsedTestCases.failedCount
    passedCount += parsedTestCases.passedCount
    retriedCount += parsedTestCases.retriedCount
    flakyCount += parsedTestCases.flakyCount
    time += parsedTestCases.time
    annotations.push(...parsedTestCases.annotations)
    globalAnnotations.push(...parsedTestCases.annotations)
  }
  // if we have a limit, and we are above the limit, return fast
  if (annotationsLimit > 0 && globalAnnotations.length >= annotationsLimit) {
    return {
      name: suiteName,
      totalCount,
      skippedCount,
      failedCount,
      passedCount,
      retriedCount,
      flakyCount,
      time,
      annotations,
      globalAnnotations,
      testResults: []
    }
  }

  // parse child test suites
  const childTestSuites = suite.testsuite
    ? Array.isArray(suite.testsuite)
      ? suite.testsuite
      : [suite.testsuite]
    : Array.isArray(suite.testsuites)
      ? suite.testsuites
      : [suite.testsuites]

  const childSuiteResults: ActualTestResult[] = []
  const childBreadCrumb = suiteName ? `${breadCrumb}${suiteName}${breadCrumbDelimiter}` : breadCrumb
  for (const childSuite of childTestSuites) {
    const childSuiteResult = await parseSuite(
      childSuite,
      suiteRegex,
      childBreadCrumb,
      breadCrumbDelimiter,
      includePassed,
      annotateNotice,
      checkRetries,
      excludeSources,
      checkTitleTemplate,
      testFilesPrefix,
      transformer,
      followSymlink,
      annotationsLimit,
      truncateStackTraces,
      globalAnnotations,
      resolveIgnoreClassname,
      annotateFlaky
    )

    if (childSuiteResult) {
      childSuiteResults.push(childSuiteResult)
      totalCount += childSuiteResult.totalCount
      skippedCount += childSuiteResult.skippedCount
      failedCount += childSuiteResult.failedCount
      passedCount += childSuiteResult.passedCount
      retriedCount += childSuiteResult.retriedCount
      flakyCount += childSuiteResult.flakyCount
      time += childSuiteResult.time
    }

    // skip out if we reached our annotations limit
    if (annotationsLimit > 0 && globalAnnotations.length >= annotationsLimit) {
      return {
        name: suiteName,
        totalCount,
        skippedCount,
        failedCount,
        passedCount,
        retriedCount,
        flakyCount,
        time,
        annotations,
        globalAnnotations,
        testResults: childSuiteResults
      }
    }
  }

  return {
    name: suiteName,
    totalCount,
    skippedCount,
    failedCount,
    passedCount,
    retriedCount,
    flakyCount,
    time,
    annotations,
    globalAnnotations,
    testResults: childSuiteResults
  }
}

/**
 * Helper function to create an annotation for a test case
 */
async function createTestCaseAnnotation(
  testcase: any,
  issue: TestCaseIssue | null,
  failureIndex: number,
  totalFailures: number,
  suiteName: string,
  suiteFile: string | null,
  suiteLine: string | null,
  breadCrumb: string,
  testTime: number,
  skip: boolean,
  success: boolean,
  annotationLevel: 'failure' | 'notice' | 'warning',
  flakyFailuresCount: number,
  annotateNotice: boolean,
  failed: boolean,
  excludeSources: string[],
  checkTitleTemplate: string | undefined,
  testFilesPrefix: string,
  transformer: Transformer[],
  followSymlink: boolean,
  truncateStackTraces: boolean,
  resolveIgnoreClassname: boolean
): Promise<Annotation> {
  // Extract stack trace from a failure/error node.
  const stackTrace: string = ((issue && issue._cdata) || (issue && issue._text) || '').toString().trim()

  const stackTraceMessage = truncateStackTraces ? stackTrace.split('\n').slice(0, 2).join('\n') : stackTrace

  // Extract message from a failure/error node.
  const message: string = (
    (issue && issue._attributes && issue._attributes.message) ||
    stackTraceMessage ||
    testcase._attributes.name
  ).trim()

  // Determine class name for resolution
  let resolveClassname = testcase._attributes.name
  if (!resolveIgnoreClassname && testcase._attributes.classname) {
    resolveClassname = testcase._attributes.classname
  }

  // Resolve file and line information
  const pos = await resolveFileAndLine(
    testcase._attributes.file || issue?._attributes?.file || suiteFile,
    testcase._attributes.line || issue?._attributes?.line || suiteLine,
    resolveClassname,
    stackTrace
  )

  // Apply transformations to filename
  let transformedFileName = pos.fileName
  for (const r of transformer) {
    transformedFileName = applyTransformer(r, transformedFileName)
  }

  // Resolve the full path
  const githubWorkspacePath = process.env['GITHUB_WORKSPACE']
  let resolvedPath: string = transformedFileName
  if (failed || (annotateNotice && success)) {
    if (fs.existsSync(transformedFileName)) {
      resolvedPath = transformedFileName
    } else if (githubWorkspacePath && fs.existsSync(`${githubWorkspacePath}${transformedFileName}`)) {
      resolvedPath = `${githubWorkspacePath}${transformedFileName}`
    } else {
      resolvedPath = await resolvePath(githubWorkspacePath || '', transformedFileName, excludeSources, followSymlink)
    }
  }

  core.debug(`Path prior to stripping: ${resolvedPath}`)
  if (githubWorkspacePath) {
    resolvedPath = resolvedPath.replace(`${githubWorkspacePath}/`, '') // strip workspace prefix, make the path relative
  }

  // Generate title
  let title = ''
  if (checkTitleTemplate) {
    // ensure to not duplicate the test_name if file_name is equal
    const fileName = pos.fileName !== testcase._attributes.name ? transformedFileName : ''
    const baseClassName = testcase._attributes.classname ? testcase._attributes.classname : testcase._attributes.name
    const className = baseClassName.split('.').slice(-1)[0]
    title = checkTitleTemplate
      .replace(templateVar('FILE_NAME'), fileName)
      .replace(templateVar('BREAD_CRUMB'), breadCrumb ?? '')
      .replace(templateVar('SUITE_NAME'), suiteName ?? '')
      .replace(templateVar('TEST_NAME'), testcase._attributes.name)
      .replace(templateVar('CLASS_NAME'), className)
  } else if (pos.fileName !== testcase._attributes.name) {
    // special handling to use class name only for title in case class name was ignored for `resolveClassname`
    if (resolveIgnoreClassname && testcase._attributes.classname) {
      title = `${testcase._attributes.classname}.${testcase._attributes.name}`
    } else {
      title = `${pos.fileName}.${testcase._attributes.name}`
    }
  } else {
    title = `${testcase._attributes.name}`
  }

  // Add failure index to title if multiple failures exist
  if (totalFailures > 1) {
    title = `${title} (failure ${failureIndex + 1}/${totalFailures})`
  }

  // optionally attach the prefix to the path
  resolvedPath = testFilesPrefix ? pathHelper.join(testFilesPrefix, resolvedPath) : resolvedPath

  const testTimeString = testTime > 0 ? ` ${testTime}s` : ''
  core.info(`${resolvedPath}:${pos.line} | ${message.split('\n', 1)[0]}${testTimeString}`)

  return {
    path: resolvedPath,
    start_line: pos.line,
    end_line: pos.line,
    start_column: 0,
    end_column: 0,
    retries: (testcase.retries || 0) + flakyFailuresCount,
    annotation_level: annotationLevel,
    status: skip ? 'skipped' : success ? 'success' : 'failure',
    title: escapeEmoji(title),
    message: escapeEmoji(message),
    raw_details: escapeEmoji(stackTrace),
    time: testTime
  }
}

function isSkipped(testcase: any): boolean {
  return Boolean(
    testcase.skipped || testcase._attributes.status === 'disabled' || testcase._attributes.status === 'ignored'
  )
}

/** How good an attempt of a retried test is, when picking the one to report: Success > Failure > Skip. */
enum AttemptRank {
  Skipped,
  Failed,
  Passed
}

function attemptRank(testcase: any): AttemptRank {
  if (isSkipped(testcase)) return AttemptRank.Skipped
  return testcase.failure || testcase.error ? AttemptRank.Failed : AttemptRank.Passed
}

async function parseTestCases(
  suiteName: string,
  suiteFile: string | null,
  suiteLine: string | null,
  breadCrumb: string,
  testcases: any[],
  includePassed = false,
  annotateNotice = false,
  checkRetries = false,
  excludeSources: string[],
  checkTitleTemplate: string | undefined = undefined,
  testFilesPrefix = '',
  transformer: Transformer[],
  followSymlink: boolean,
  truncateStackTraces: boolean,
  limit = -1,
  resolveIgnoreClassname = false,
  annotateFlaky = false
): Promise<TestCasesResult> {
  const toIssueArray = (value: any): TestCaseIssue[] => {
    if (!value) return []
    return Array.isArray(value) ? value : [value]
  }

  const annotations: Annotation[] = []
  let totalCount = 0
  let skippedCount = 0
  let retriedCount = 0
  let flakyCount = 0
  let time = 0
  if (checkRetries) {
    // identify duplicates in case of flaky tests, and remove them
    // Use a compound key including name, classname (if available), and file (if available)
    // to prevent accidental duplicate matches across different test classes/files
    const testcaseMap = new Map<string, any>()
    const flakyKeys = new Set<string>()
    for (const testcase of testcases) {
      const name = testcase._attributes.name
      const classname = testcase._attributes.classname || ''
      const file = testcase._attributes.file || ''
      const key = `${name}|${classname}|${file}`

      if (testcaseMap.get(key) !== undefined) {
        // testcase with matching key exists - this test was retried
        const previous = testcaseMap.get(key)
        const rank = attemptRank(testcase)
        const previousRank = attemptRank(previous)

        // Increment retry count for each additional occurrence
        const currentRetries = (previous.retries || 0) + 1
        retriedCount += 1

        if (rank >= previousRank) {
          // Success beats failure beats skip, and the latest attempt wins among equals.
          // The failed attempts a testcase carries are the ones before it, in order.
          testcase.retries = currentRetries
          testcase.failedAttempts =
            previousRank === AttemptRank.Failed ? [...previous.failedAttempts, previous] : previous.failedAttempts
          testcaseMap.set(key, testcase)
          core.debug(`Retried test, keeping the latest attempt for: ${key}`)
        } else {
          // A worse attempt than the kept one: keep the previous result, remembering a failure in case it is a success
          previous.retries = currentRetries
          if (rank === AttemptRank.Failed) {
            previous.failedAttempts.push(testcase)
          }
          core.debug(`Retried test, keeping the better attempt for: ${key}`)
        }

        // A success and a failure of the same test make it flaky. Counted once, the first time they meet.
        // retriedCount above counts every extra attempt, so a test retried twice adds 2 there but only 1 here.
        const kept = testcaseMap.get(key)
        if (attemptRank(kept) === AttemptRank.Passed && kept.failedAttempts.length > 0 && !flakyKeys.has(key)) {
          flakyKeys.add(key)
          flakyCount++
        }
      } else {
        // Every kept testcase carries the failed attempts that are not itself: a passing one reports them as flaky.
        testcase.failedAttempts = []
        testcaseMap.set(key, testcase)
      }
    }
    testcases = Array.from(testcaseMap.values())
  }

  let testCaseFailedCount = 0 // Track number of test cases that failed

  for (const testcase of testcases) {
    totalCount++

    // fish the time-taken out of the test case attributes, if present
    const testTime = testcase._attributes.time === undefined ? 0 : parseFloat(testcase._attributes.time)
    time += testTime

    const failureIssues = toIssueArray(testcase.failure)
    const errorIssues = toIssueArray(testcase.error)
    const issues = [...failureIssues, ...errorIssues]
    const testFailure = issues.length > 0 // test failed
    const skip = isSkipped(testcase)
    const failed = testFailure && !skip // test failure, but was skipped -> don't fail if a ignored test failed
    const success = !testFailure // not a failure -> thus a success
    const annotationLevel = success || skip ? 'notice' : 'failure' // a skipped test shall not fail the run

    if (skip) {
      skippedCount++
    }

    // Count this test case as failed if it has any failures (regardless of how many)
    if (failed) {
      testCaseFailedCount++
    }

    // identify the number of flaky failures (check this early to allow flaky tests through)
    const flakyFailuresCount = testcase.flakyFailure
      ? Array.isArray(testcase.flakyFailure)
        ? testcase.flakyFailure.length
        : 1
      : 0

    // A flaky test (failed, then passed on retry): report each failed attempt as a warning with its failure
    // details, so the report shows what failed even though the test counts as passed.
    const flakyAttempts: any[] = annotateFlaky && !testFailure && !skip ? testcase.failedAttempts || [] : []
    for (let attemptIndex = 0; attemptIndex < flakyAttempts.length; attemptIndex++) {
      const attempt = flakyAttempts[attemptIndex]
      const attemptIssues = [...toIssueArray(attempt.failure), ...toIssueArray(attempt.error)]
      const attemptAnnotation = await createTestCaseAnnotation(
        attempt,
        attemptIssues[0] ?? null,
        0,
        1,
        suiteName,
        suiteFile,
        suiteLine,
        breadCrumb,
        attempt._attributes.time === undefined ? 0 : parseFloat(attempt._attributes.time),
        false,
        false,
        'warning',
        0,
        annotateNotice,
        true,
        excludeSources,
        checkTitleTemplate,
        testFilesPrefix,
        transformer,
        followSymlink,
        truncateStackTraces,
        resolveIgnoreClassname
      )
      attemptAnnotation.title = `${attemptAnnotation.title} (flaky: failed attempt ${attemptIndex + 1}/${flakyAttempts.length})`
      attemptAnnotation.status = 'success' // the test passed in the end, this must not count as a failure
      attemptAnnotation.retries = 0
      annotations.push(attemptAnnotation)
    }
    const isFlaky = flakyAttempts.length > 0

    // If this isn't reported as a failure and processing all passed tests
    // isn't enabled, then skip the rest of the processing.
    // Exception: if the test has flaky failures, always process it to track retries
    if (annotationLevel !== 'failure' && !includePassed && flakyFailuresCount === 0 && !isFlaky) {
      continue
    }

    // Handle multiple failures/errors or single case (success/skip).
    const issuesToProcess = issues.length > 0 ? issues : [null] // Process at least once for non-failure cases

    for (let failureIndex = 0; failureIndex < issuesToProcess.length; failureIndex++) {
      const issue = issuesToProcess[failureIndex]

      const annotation = await createTestCaseAnnotation(
        testcase,
        issue,
        failureIndex,
        issues.length,
        suiteName,
        suiteFile,
        suiteLine,
        breadCrumb,
        testTime,
        skip,
        success,
        annotationLevel,
        flakyFailuresCount,
        annotateNotice,
        failed,
        excludeSources,
        checkTitleTemplate,
        testFilesPrefix,
        transformer,
        followSymlink,
        truncateStackTraces,
        resolveIgnoreClassname
      )

      annotations.push(annotation)

      if (limit >= 0 && annotations.length >= limit) break
    }

    // Break from the outer testcase loop if we've reached the limit
    if (limit >= 0 && annotations.length >= limit) break
  }

  const failedCount = testCaseFailedCount // Use test case count, not annotation count
  const passedCount = totalCount - failedCount - skippedCount
  return {
    totalCount,
    skippedCount,
    failedCount,
    passedCount,
    retriedCount,
    flakyCount,
    time,
    annotations
  }
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L113
 *
 * Modification Copyright 2022 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function parseTestReports(
  checkName: string,
  summary: string,
  reportPaths: string,
  suiteRegex: string, // no-op
  includePassed = false,
  annotateNotice = false,
  checkRetries = false,
  excludeSources: string[],
  checkTitleTemplate: string | undefined = undefined,
  breadCrumbDelimiter: string,
  testFilesPrefix = '',
  transformer: Transformer[] = [],
  followSymlink = false,
  annotationsLimit = -1,
  truncateStackTraces = true,
  failOnParseError = false,
  resolveIgnoreClassname = false,
  annotateFlaky = false
): Promise<TestResult> {
  core.debug(`Process test report for: ${reportPaths} (${checkName})`)
  const files = await glob(reportPaths, {follow: followSymlink})
  const globalAnnotations: Annotation[] = []
  const testResults: ActualTestResult[] = []
  let totalCount = 0
  let skipped = 0
  let failed = 0
  let passed = 0
  let retried = 0
  let flaky = 0
  let time = 0
  let foundFiles = 0
  for (const file of files) {
    foundFiles++
    core.debug(`Parsing report file: ${file}`)

    const testResult = await parseFile(
      file,
      suiteRegex,
      includePassed,
      annotateNotice,
      checkRetries,
      excludeSources,
      checkTitleTemplate,
      breadCrumbDelimiter,
      testFilesPrefix,
      transformer,
      followSymlink,
      annotationsLimit,
      truncateStackTraces,
      failOnParseError,
      globalAnnotations,
      resolveIgnoreClassname,
      annotateFlaky
    )

    if (!testResult) continue
    const {
      totalCount: c,
      skippedCount: s,
      failedCount: f,
      passedCount: p,
      retriedCount: r,
      flakyCount: fl,
      time: t
    } = testResult
    totalCount += c
    skipped += s
    failed += f
    passed += p
    retried += r
    flaky += fl
    time += t
    testResults.push(testResult)

    if (annotationsLimit > 0 && globalAnnotations.length >= annotationsLimit) {
      break
    }
  }

  return {
    checkName,
    summary,
    totalCount,
    skipped,
    failed,
    passed,
    retried,
    flaky,
    time,
    foundFiles,
    globalAnnotations,
    testResults
  }
}

/**
 * Escape emoji sequences.
 */
export function escapeEmoji(input: string): string {
  const regex =
    /[\u{1f300}-\u{1f5ff}\u{1f900}-\u{1f9ff}\u{1f600}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\u{1f1e6}-\u{1f1ff}\u{1f191}-\u{1f251}\u{1f004}\u{1f0cf}\u{1f170}-\u{1f171}\u{1f17e}-\u{1f17f}\u{1f18e}\u{3030}\u{2b50}\u{2b55}\u{2934}-\u{2935}\u{2b05}-\u{2b07}\u{2b1b}-\u{2b1c}\u{3297}\u{3299}\u{303d}\u{00a9}\u{00ae}\u{2122}\u{23f3}\u{24c2}\u{23e9}-\u{23ef}\u{25b6}\u{23f8}-\u{23fa}]/gu
  return input.replace(regex, ``) // replace emoji with empty string (\\u${(match.codePointAt(0) || "").toString(16)})
}
