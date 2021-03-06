import inquirer from 'inquirer'
import Listr from 'listr'
import path from 'path'
import chalk from 'chalk'
import execa from 'execa'
import fs from 'fs-extra'
import nunjucks from 'nunjucks'
import { toBuffer, privateToPublic, bufferToHex } from 'ethereumjs-util'

import { Delivery } from '../delivery'
//import { Ganache } from '../ganache'
import { Genesis } from '../genesis'
import { printDependencyInstructions, getDefaultBranch } from '../helper'
import { getNewPrivateKey, getKeystoreFile, processTemplateFiles, getAccountFromPrivateKey } from '../../lib/utils'
import { loadConfig } from '../config'
import fileReplacer from '../../lib/file-replacer'

export class Devnet {
  constructor(config, options = {}) {
    this.config = config
}

  get testnetDir() {
    return path.join(this.config.targetDirectory, 'devnet')
  }

  get signerDumpPath() {
    return path.join(this.testnetDir, 'signer-dump.json')
  }

  get signerDumpData() {
    return require(this.signerDumpPath)
  }

  get totalNodes() {
    return this.config.numOfValidators + this.config.numOfNonValidators
  }

  get deliveryBuildDir() {
    return path.join(this.config.targetDirectory, 'code/delivery/build')
  }

  nodeDir(index) {
    return path.join(this.testnetDir, `node${index}`)
  }

  deliveryDir(index) {
    return path.join(this.nodeDir(index), 'deliveryd')
  }

  deliveryConfigFilePath(index) {
    return path.join(this.deliveryDir(index), 'config', 'config.toml')
  }

  deliveryStartShellFilePath(index) {
    return path.join(this.nodeDir(index), 'delivery-start.sh')
  }

  rabbitDockerFilePath(index) {
    return path.join(this.nodeDir(index), 'docker-compose.yml')
  }

  deliveryServerStartShellFilePath(index) {
    return path.join(this.nodeDir(index), 'delivery-server-start.sh')
  }
  deliveryBridgeStartShellFilePath(index) {
    return path.join(this.nodeDir(index), 'delivery-bridge-start.sh')
  }

  panoStartShellFilePath(index) {
    return path.join(this.nodeDir(index), 'pano-start.sh')
  }
  panoSetupShellFilePath(index) {
    return path.join(this.nodeDir(index), 'pano-setup.sh')
  }

  deliveryGenesisFilePath(index) {
    return path.join(this.deliveryDir(index), 'config', 'genesis.json')
  }

  deliveryDeliveryConfigFilePath(index) {
    return path.join(this.deliveryDir(index), 'config', 'delivery-config.toml')
  }

  panoDir(index) {
    return path.join(this.nodeDir(index), 'pano')
  }

  panoDataDir(index) {
    return path.join(this.panoDir(index), 'data')
  }

  panoDataPanoDir(index) {
    return path.join(this.panoDir(index), 'data', 'pano')
  }

  panoKeystoreDir(index) {
    return path.join(this.panoDir(index), 'keystore')
  }

  panoGenesisFilePath(index) {
    return path.join(this.panoDir(index), 'genesis.json')
  }

  panoPasswordFilePath(index) {
    return path.join(this.panoDir(index), 'password.txt')
  }

  panoPrivateKeyFilePath(index) {
    return path.join(this.panoDir(index), 'privatekey.txt')
  }

  panoAddressFilePath(index) {
    return path.join(this.panoDir(index), 'address.txt')
  }

  panoNodeKeyPath(index) {
    return path.join(this.panoDir(index), 'nodekey')
  }

  panoEnodeFilePath(index) {
    return path.join(this.panoDir(index), 'enode.txt')
  }

  panoStaticNodesPath(index) {
    return path.join(this.panoDir(index), 'static-nodes.json')
  }

  async getEnodeTask() {
    return {
      title: 'Setup enode',
      task: async () => {
        const staticNodes = []

        // create new enode
        for (let i = 0; i < this.totalNodes; i++) {
          const enodeObj = await getNewPrivateKey()
          const pubKey = bufferToHex(privateToPublic(toBuffer(enodeObj.privateKey))).replace('0x', '')

          // draft enode
          //const enode = `enode://${pubKey}@${this.config.devnetPanoHosts[i]}:3030${i}`
          const enode = `enode://${pubKey}@${this.config.devnetPanoHosts[i]}:30303`

          // add into static nodes
          staticNodes.push(enode)

          // store data into nodekey and enode
          const p = [
            // create nodekey file
            fs.writeFile(
              this.panoNodeKeyPath(i),
              `${enodeObj.privateKey.replace('0x', '')}\n`,
              { mode: 0o600 }
            ),
            // create enode file
            fs.writeFile(
              this.panoEnodeFilePath(i),
              `${enode}\n`,
              { mode: 0o600 }
            )
          ]
          await Promise.all(p)
        }

        // create static-nodes
        const data = JSON.stringify(staticNodes, null, 2)
        for (let i = 0; i < this.totalNodes; i++) {
          await fs.writeFile(
            this.panoStaticNodesPath(i),
            data,
            { mode: 0o600 }
          )
        }
      }
    }
  }

  async getDockerTasks() {
    const enodeTask = await this.getEnodeTask()
    return [
      enodeTask,
      {
        title: 'Process Delivery configs',
        task: async () => {
          // set delivery
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.deliveryDeliveryConfigFilePath(i))
              .replace(/eth_rpc_url[ ]*=[ ]*".*"/gi, `eth_rpc_url = "${this.config.ethURL}"`)
              .replace(/bsc_rpc_url[ ]*=[ ]*".*"/gi, `bsc_rpc_url = "${this.config.bscURL}"`)
              .replace(/panoptis_rpc_url[ ]*=[ ]*".*"/gi, `panoptis_rpc_url = "${this.config.troRpcURL}"`)
              .replace(/panoptis_grid_url[ ]*=[ ]*".*"/gi, `panoptis_grid_url = "${this.config.panoptisGridURL}"`)
              .replace(/pano_rpc_url[ ]*=[ ]*".*"/gi, `pano_rpc_url = "http://pano${i}:8545"`)
              .replace(/amqp_url[ ]*=[ ]*".*"/gi, `amqp_url = "amqp://guest:guest@rabbit${i}:5672/"`)
              .replace(/span_poll_interval[ ]*=[ ]*".*"/gi, 'span_poll_interval = "0m15s"')
              .replace(/checkpoint_poll_interval[ ]*=[ ]*".*"/gi, 'checkpoint_poll_interval = "1m0s"')
              .save()
          }
        }
      },
      {
        title: 'Process contract addresses',
        task: () => {
          // get root contracts
          const rootContracts = this.config.contractAddresses.root

          // set delivery peers with devnet delivery hosts
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.deliveryGenesisFilePath(i))
              .replace(/"matic_token_address":[ ]*".*"/gi, `"matic_token_address": "${rootContracts.tokens.TestToken}"`)
              .replace(/"staking_manager_address":[ ]*".*"/gi, `"staking_manager_address": "${rootContracts.StakeManagerProxy}"`)
              .replace(/"root_chain_address":[ ]*".*"/gi, `"root_chain_address": "${rootContracts.RootChainProxy}"`)
              .replace(/"staking_info_address":[ ]*".*"/gi, `"staking_info_address": "${rootContracts.StakingInfo}"`)
              .replace(/"state_sender_address":[ ]*".*"/gi, `"state_sender_address": "${rootContracts.StateSender}"`)
              .save()
          }
        },
        enabled: () => {
          return this.config.contractAddresses
        }
      },
      {
        title: 'Process templates',
        task: async () => {
          const templateDir = path.resolve(
            new URL(import.meta.url).pathname,
            '../templates'
          )

          // copy docker related templates
          await fs.copy(path.join(templateDir, 'docker'), this.config.targetDirectory)

          // process template files
          await processTemplateFiles(this.config.targetDirectory, { obj: this})
        }
      }
    ]
  }

  async getRemoteTasks() {
    const enodeTask = await this.getEnodeTask()
    return [
      enodeTask,
      {
        title: 'Process delivery configs',
        task: async () => {
          // set delivery
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.deliveryDeliveryConfigFilePath(i))
            .replace(/eth_rpc_url[ ]*=[ ]*".*"/gi, `eth_rpc_url = "${this.config.ethURL}"`)
            .replace(/bsc_rpc_url[ ]*=[ ]*".*"/gi, `bsc_rpc_url = "${this.config.bscURL}"`)
            .replace(/panoptis_rpc_url[ ]*=[ ]*".*"/gi, `panoptis_rpc_url = "${this.config.panoptisRpcURL}"`)
            .replace(/panoptis_grid_url[ ]*=[ ]*".*"/gi, `panoptis_grid_url = "${this.config.panoptisGridURL}"`)
              .replace(/pano_rpc_url[ ]*=[ ]*".*"/gi, `pano_rpc_url = "http://localhost:8545"`)
              .replace(/amqp_url[ ]*=[ ]*".*"/gi, 'amqp_url = "amqp://guest:guest@localhost:5672/"')
              .save()
          }
        }
      },
      {
        title: 'Process templates',
        task: async () => {
          const templateDir = path.resolve(
            new URL(import.meta.url).pathname,
            '../templates'
          )

          // copy remote related templates    
          await fs.copy(path.join(templateDir, 'remote'), this.config.targetDirectory)

          // promises
          const p = []
          const signerDumpData = this.signerDumpData

          // process njk files
          fs.readdirSync(this.config.targetDirectory).forEach(file => {
            if (file.indexOf('.njk') !== -1) {
              const fp = path.join(this.config.targetDirectory, file)

              // process all njk files and copy to each node directory
              for (let i = 0; i < this.totalNodes; i++) {
                fs.writeFileSync(
                  path.join(this.nodeDir(i), file.replace('.njk', '')),
                  nunjucks.render(fp, { obj: this, node: i, signerData: signerDumpData[i] })
                )
              }


              // remove njk file
              p.push(execa('rm', ['-rf', fp], {
                cwd: this.config.targetDirectory
              }))
            }
          })
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.panoStartShellFilePath(i))
            //.replace(/NODE_DIR=/gi, `NODE_DIR=${this.config.nodeDir}${i}`)
            .replace(/BTTC_CHAIN_ID=/gi, `BTTC_CHAIN_ID=${this.config.panoChainId}`) 
            .save()
          }
          
          // fulfill all promises
          await Promise.all(p)
        }
      }
      
    ]
  }

  async getCreateTestnetTask(delivery) {
    return [
      delivery.cloneRepositoryTask(),
      delivery.buildTask(),
      {
        title: 'Create testnet files for delivery',
        task: async () => {
          const args = [
            'create-testnet',
            '--v', this.config.numOfValidators,
            '--n', this.config.numOfNonValidators,
            '--chain-id', this.config.deliveryChainId,
            '--node-host-prefix', 'delivery',
            '--output-dir', 'devnet'
          ]

          // create testnet
          await execa(delivery.deliverydCmd, args, {
            cwd: this.config.targetDirectory
          })

          // set delivery peers with devnet delivery hosts
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.deliveryConfigFilePath(i))
            .replace(/delivery([^:]+)/gi, (d, index) => {
              return `${this.config.devnetDeliveryHosts[index]}`
            })             
            .replace(/moniker.+=.+/gi, `moniker = "delivery${i}"`)
            .save()

            fileReplacer(this.deliveryGenesisFilePath(i))
              .replace(/"bor_chain_id"[ ]*:[ ]*".*"/gi, `"bor_chain_id": "${this.config.panoChainId}"`)
              .save()
          }
        }
      }
    ]
  }

  async getTasks() {
    //const ganache = this.ganache
    const delivery = this.delivery
    const genesis = this.genesis

    // create testnet tasks
    const createTestnetTasks = await this.getCreateTestnetTask(delivery)

    return new Listr(
      [
        ...createTestnetTasks,
        {
          title: 'Setup accounts',
          task: () => {
            // set validator addresses
            const genesisAddresses = []
            const signerDumpData = this.signerDumpData
            for (let i = 0; i < this.config.numOfValidators; i++) {
              const d = signerDumpData[i]
              genesisAddresses.push(d.address)
            }

            // set genesis addresses
            this.config.genesisAddresses = genesisAddresses

            // setup accounts from signer dump data (based on number of validators)
            this.config.accounts = this.signerDumpData.slice(0, this.config.numOfValidators).map(s => {
              return getAccountFromPrivateKey(s.priv_key)
            })
          }
        },
        {
          title: genesis.taskTitle,
          task: () => {
            // get genesis tasks
            return genesis.getTasks()
          }
        },
        {
          title: 'Setup Pano keystore and genesis files',
          task: async () => {
            const signerDumpData = this.signerDumpData

            for (let i = 0; i < this.totalNodes; i++) {
              // create directories
              await execa('mkdir', ['-p', this.panoDataDir(i), this.panoKeystoreDir(i)])
              const password = `password${i}`

              // create keystore files
              const keystoreFileObj = getKeystoreFile(signerDumpData[i].priv_key, password)
              const p = [
                // save password file
                fs.writeFile(
                  this.panoPasswordFilePath(i),
                  `${password}\n`
                ),
                // save private key file
                fs.writeFile(
                  this.panoPrivateKeyFilePath(i),
                  `${signerDumpData[i].priv_key}\n`
                ),
                // save address file
                fs.writeFile(
                  this.panoAddressFilePath(i),
                  `${signerDumpData[i].address}\n`
                ),
                // save keystore file
                fs.writeFile(
                  path.join(this.panoKeystoreDir(i), keystoreFileObj.keystoreFilename),
                  JSON.stringify(keystoreFileObj.keystore, null, 2)
                ),
                // copy genesis file to each node pano directory
                execa('cp', [genesis.panoGenesisFilePath, this.panoGenesisFilePath(i)])
              ]
              await Promise.all(p)
            }
          }
        },
        // {
        //   title: ganache.taskTitle,
        //   task: () => {
        //     return ganache.getTasks()
        //   },
        //   enabled: () => {
        //     return this.config.devnetType === 'docker'
        //   }
        // },
        {
          title: 'Docker',
          task: async () => {
            const tasks = await this.getDockerTasks()
            return new Listr(tasks)
          },
          enabled: () => {
            return this.config.devnetType === 'docker'
          }
        },
        {
          title: 'Remote',
          task: async () => {
            const tasks = await this.getRemoteTasks()
            return new Listr(tasks)
          },
          enabled: () => {
            return this.config.devnetType === 'remote'
          }
        }
      ]
    )
  }
}

async function setupDevnet(config) {
  const devnet = new Devnet(config)
  //devnet.ganache = new Ganache(config, { contractsBranch: config.contractsBranch })
  devnet.delivery = new Delivery(config, { repositoryBranch: config.deliveryBranch })
  devnet.genesis = new Genesis(config, { repositoryBranch: 'master' })

  const tasks = await devnet.getTasks()
  await tasks.run()
  console.log('%s Devnet is ready', chalk.green.bold('DONE'))
}

export async function getHosts(n) {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'devnetHosts',
      message: 'Please enter comma separated hosts/IPs',
      validate: (input) => {
        const hosts = input.split(',').map(a => {
          return a.trim().toLowerCase()
        })

        if (hosts.length === 0 || hosts.length !== n) {
          return `Enter valid ${n} hosts/IPs (comma separated)`
        }

        return true
      }
    }
  ])

  return answers.devnetHosts.split(',').map(a => {
    return a.trim().toLowerCase()
  })
}

export default async function () {
  await printDependencyInstructions()

  // configuration
  const config = await loadConfig()
  await config.loadChainIds()

  // load branch
  let answers = await getDefaultBranch(config)
  config.set(answers)

  const questions = []
  if (!('numOfValidators' in config)) {
    questions.push({
      type: 'number',
      name: 'numOfValidators',
      message: 'Please enter number of validator nodes',
      default: 2
    })
  }

  if (!('numOfNonValidators' in config)) {
    questions.push({
      type: 'number',
      name: 'numOfNonValidators',
      message: 'Please enter number of non-validator nodes',
      default: 2
    })
  }

  if (!('ethURL' in config)) {
    questions.push({
      type: 'input',
      name: 'ethURL',
      message: 'Please enter ETH url',
      default: ''
    })
  }

  if (!('bscURL' in config)) {
    questions.push({
      type: 'input',
      name: 'bscURL',
      message: 'Please enter BSC url',
      default: ''
    })
  }

  if (!('panoptisRpcURL' in config)) {
    questions.push({
      type: 'input',
      name: 'panoptisRpcURL',
      message: 'Please enter PANO rpc url',
      default: ''
    })
  }

  if (!('panoptisGridURL' in config)) {
    questions.push({
      type: 'input',
      name: 'panoptisGridURL',
      message: 'Please enter PANO grid url',
      default: ''
    })
  }


  if (!('devnetType' in config)) {
    questions.push({
      type: 'list',
      name: 'devnetType',
      message: 'Please select devnet type',
      choices: [
        'docker',
        'remote'
      ]
    })
  }

  answers = await inquirer.prompt(questions)
  config.set(answers)

  // set devent hosts
  let devnetPanoHosts = []
  let devnetDeliveryHosts = []
  const totalValidators = config.numOfValidators + config.numOfNonValidators
  if (config.devnetType === 'docker') {
    [...Array(totalValidators).keys()].forEach((i) => {
      devnetPanoHosts.push(`172.20.1.${i + 100}`)
      devnetDeliveryHosts.push(`delivery${i}`)
    })
  } else {
    const hosts = await getHosts(totalValidators)
    devnetPanoHosts = hosts
    devnetDeliveryHosts = hosts
  }
  config.set({ devnetPanoHosts: devnetPanoHosts, devnetDeliveryHosts: devnetDeliveryHosts })

  // start setup
  await setupDevnet(config)
}
