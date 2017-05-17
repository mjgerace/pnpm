import tape = require('tape')
import promisifyTape from 'tape-promise'
import writeYamlFile = require('write-yaml-file')
import exists = require('path-exists')
import {prepare, testDefaults, addDistTag} from './utils'
import {installPkgs, install} from '../src'
import readPkg = require('read-pkg')
import writePkg = require('write-pkg')
import rimraf = require('rimraf-then')

const test = promisifyTape(tape)

test('shrinkwrap file has correct format', async t => {
  const project = prepare(t)

  await installPkgs(['pkg-with-1-dep', '@rstacruz/tap-spec@4.1.1', 'kevva/is-negative'], testDefaults({save: true}))

  const shr = await project.loadShrinkwrap()
  const id = '/pkg-with-1-dep/100.0.0'

  t.equal(shr.version, 2, 'correct shrinkwrap version')

  t.ok(shr.registry, 'has registry field')

  t.ok(shr.specifiers, 'has specifiers field')
  t.ok(shr.packages['/'], 'has root field')
  t.ok(shr.packages['/'].dependencies, 'has root dependencies field')
  t.equal(shr.packages['/'].dependencies['pkg-with-1-dep'], '100.0.0', 'has dependency resolved')
  t.ok(shr.packages['/'].dependencies['@rstacruz/tap-spec'], 'has scoped dependency resolved')
  t.ok(shr.packages['/'].dependencies['is-negative'].indexOf('/') !== -1, 'has not shortened tarball from the non-standard registry')

  t.ok(shr.packages, 'has packages field')
  t.ok(shr.packages[id], `has resolution for ${id}`)
  t.ok(shr.packages[id].dependencies, `has dependency resolutions for ${id}`)
  t.ok(shr.packages[id].dependencies['dep-of-pkg-with-1-dep'], `has dependency resolved for ${id}`)
  t.ok(shr.packages[id].resolution, `has resolution for ${id}`)
  t.ok(!shr.packages[id].resolution.tarball, `has no tarball for package in the default registry`)
})

test('shrinkwrap file has dev deps even when installing for prod only', async (t: tape.Test) => {
  const project = prepare(t, {
    devDependencies: {
      'is-negative': '2.1.0',
    },
  })

  await install(testDefaults({production: true}))

  const shr = await project.loadShrinkwrap()
  const id = '/is-negative/2.1.0'

  t.ok(shr.packages, 'has packages field')

  t.equal(shr.packages['/'].dependencies['is-negative'], '2.1.0', 'has dependency resolved')

  t.ok(shr.packages[id], `has resolution for ${id}`)
})

test('shrinkwrap with scoped package', async t => {
  const project = prepare(t, {
    dependencies: {
      '@types/semver': '^5.3.31',
    },
  })

  await writeYamlFile('shrinkwrap.yaml', {
    packages: {
      '/': {
        dependencies: {
          '@types/semver': '5.3.31',
        },
      },
      '/@types/semver/5.3.31': 'b999d7d935f43f5207b01b00d3de20852f4ca75f',
    },
    registry: 'http://localhost:4873',
    version: 2,
  })

  await install(testDefaults())
})

test('fail when shasum from shrinkwrap does not match with the actual one', async t => {
  const project = prepare(t, {
    dependencies: {
      'is-negative': '2.1.0',
    },
  })

  await writeYamlFile('shrinkwrap.yaml', {
    version: 2,
    registry: 'http://localhost:4873',
    packages: {
      '/': {
        dependencies: {
          'is-negative': '2.1.0',
        },
      },
      '/is-negative/2.1.0': {
        resolution: {
          shasum: '00000000000000000000000000000000000000000',
          tarball: 'http://localhost:4873/is-negative/-/is-negative-2.1.0.tgz',
        },
      },
    },
  })

  try {
    await install(testDefaults())
    t.fail('installation should have failed')
  } catch (err) {
    t.ok(err.message.indexOf('Incorrect shasum') !== -1, 'failed with expected error')
  }
})

test("shrinkwrap doesn't lock subdependencies that don't satisfy the new specs", async t => {
  const project = prepare(t)

  // dependends on react-onclickoutside@5.9.0
  await installPkgs(['react-datetime@2.8.8'], testDefaults({save: true}))

  // dependends on react-onclickoutside@0.3.4
  await installPkgs(['react-datetime@1.3.0'], testDefaults({save: true}))

  t.equal(
    project.requireModule('.localhost+4873/react-datetime/1.3.0/node_modules/react-onclickoutside/package.json').version,
    '0.3.4',
    'react-datetime@1.3.0 has react-onclickoutside@0.3.4 in its node_modules')

  const shr = await project.loadShrinkwrap()

  t.equal(Object.keys(shr.packages['/'].dependencies).length, 1, 'resolutions not duplicated')
})

test('shrinkwrap not created when no deps in package.json', async t => {
  const project = prepare(t)

  await install(testDefaults())

  t.ok(!await project.loadShrinkwrap(), 'shrinkwrap file not created')
})

test('shrinkwrap removed when no deps in package.json', async t => {
  const project = prepare(t)

  await writeYamlFile('shrinkwrap.yaml', {
    version: 2,
    registry: 'http://localhost:4873',
    packages: {
      '/': {
        dependencies: {
          'is-negative': '2.1.0',
        },
      },
      '/is-negative/2.1.0': {
        resolution: {
          tarball: 'http://localhost:4873/is-negative/-/is-negative-2.1.0.tgz',
        },
      },
    },
  })

  await install(testDefaults())

  t.ok(!await project.loadShrinkwrap(), 'shrinkwrap file removed')
})

test('respects shrinkwrap.yaml for top dependencies', async t => {
  const project = prepare(t)

  await addDistTag('dep-of-pkg-with-1-dep', '100.0.0', 'latest')

  await installPkgs(['dep-of-pkg-with-1-dep'], testDefaults({save: true}))

  await project.storeHas('dep-of-pkg-with-1-dep', '100.0.0')

  await addDistTag('dep-of-pkg-with-1-dep', '100.1.0', 'latest')

  await install(testDefaults())

  await project.storeHasNot('dep-of-pkg-with-1-dep', '100.1.0')
})

test('subdeps are updated on repeat install if outer shrinkwrap.yaml does not match the inner one', async (t: tape.Test) => {
  const project = prepare(t)

  await addDistTag('dep-of-pkg-with-1-dep', '100.0.0', 'latest')

  await installPkgs(['pkg-with-1-dep'], testDefaults())

  await project.storeHas('dep-of-pkg-with-1-dep', '100.0.0')

  const shr = await project.loadShrinkwrap()

  t.ok(shr.packages['/dep-of-pkg-with-1-dep/100.0.0'])

  delete shr.packages['/dep-of-pkg-with-1-dep/100.0.0']

  shr.packages['/dep-of-pkg-with-1-dep/100.1.0'] = 'b1dccbab9ab987b87ad4778207e1cb7fe948fb3c'

  shr.packages['/pkg-with-1-dep/100.0.0']['dependencies']['dep-of-pkg-with-1-dep'] = '100.1.0'

  await writeYamlFile('shrinkwrap.yaml', shr)

  await install(testDefaults())

  await project.storeHas('dep-of-pkg-with-1-dep', '100.1.0')
})

test("recreates shrinkwrap file if it doesn't match the dependencies in package.json", async (t: tape.Test) => {
  const project = prepare(t)

  await installPkgs(['is-negative@2.0.0'], testDefaults({saveExact: true}))

  const shr1 = await project.loadShrinkwrap()
  t.equal(shr1.packages['/'].dependencies['is-negative'], '2.0.0')
  t.equal(shr1.specifiers['is-negative'], '2.0.0')

  const pkg = await readPkg()

  pkg.dependencies['is-negative'] = '^2.1.0'

  await writePkg(pkg)

  await install(testDefaults())

  const shr = await project.loadShrinkwrap()

  t.equal(shr.packages['/'].dependencies['is-negative'], '2.1.0')
  t.equal(shr.specifiers['is-negative'], '^2.1.0')
})

test('repeat install with shrinkwrap should not mutate shrinkwrap when dependency has version specified with v prefix', async (t: tape.Test) => {
  const project = prepare(t)

  await installPkgs(['highmaps-release@5.0.11'], testDefaults())

  const shr1 = await project.loadShrinkwrap()

  t.equal(shr1.packages['/'].dependencies['highmaps-release'], '5.0.11')

  await rimraf('node_modules')

  await install(testDefaults())

  const shr2 = await project.loadShrinkwrap()

  t.deepEqual(shr1, shr2)
})
